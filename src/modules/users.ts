import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { hashPassword } from '../lib/password'
import { requireAuth, requireRole } from '../middleware/auth'
import { recordAudit } from '../middleware/audit'

const ROLES = ['admin', 'ti', 'mejora-continua'] as const

const createSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(ROLES),
})

const updateRoleSchema = z.object({
  role: z.enum(ROLES),
})

export const usersRouter: Router = Router()

usersRouter.use(requireAuth)

// list — admin y ti pueden leer
usersRouter.get('/', requireRole('admin', 'ti'), async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      active: true,
      createdAt: true,
      lastLoginAt: true,
    },
  })
  return res.json({ users })
})

// create — admin only
usersRouter.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'payload invalido' })

  const { name, email, password, role } = parsed.data
  const emailNorm = email.toLowerCase().trim()

  const exists = await prisma.user.findUnique({ where: { email: emailNorm } })
  if (exists) return res.status(409).json({ error: 'email ya registrado' })

  const passwordHash = await hashPassword(password)
  const user = await prisma.user.create({
    data: { name, email: emailNorm, passwordHash, role, active: true },
    select: {
      id: true, name: true, email: true, role: true, active: true, createdAt: true,
    },
  })

  await recordAudit({
    actor: req.user!.email,
    action: 'user.create',
    target: user.email,
    details: `role=${user.role}`,
  })

  return res.status(201).json({ user })
})

// update role — admin only
usersRouter.patch('/:id/role', requireRole('admin'), async (req: Request<{ id: string }>, res: Response) => {
  const parsed = updateRoleSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'role invalido' })

  const target = await prisma.user.findUnique({ where: { id: req.params.id } })
  if (!target) return res.status(404).json({ error: 'user not found' })

  if (target.role === parsed.data.role) return res.json({ user: target })

  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { role: parsed.data.role },
    select: {
      id: true, name: true, email: true, role: true, active: true, createdAt: true, lastLoginAt: true,
    },
  })

  await recordAudit({
    actor: req.user!.email,
    action: 'user.role_change',
    target: user.email,
    details: `${target.role} → ${user.role}`,
  })

  return res.json({ user })
})

// toggle active — admin only
usersRouter.patch('/:id/active', requireRole('admin'), async (req: Request<{ id: string }>, res: Response) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } })
  if (!target) return res.status(404).json({ error: 'user not found' })

  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { active: !target.active },
    select: {
      id: true, name: true, email: true, role: true, active: true, createdAt: true, lastLoginAt: true,
    },
  })

  await recordAudit({
    actor: req.user!.email,
    action: user.active ? 'user.enable' : 'user.disable',
    target: user.email,
  })

  return res.json({ user })
})

// reset password — admin only, genera nueva y la devuelve una sola vez
usersRouter.post('/:id/reset-password', requireRole('admin'), async (req: Request<{ id: string }>, res: Response) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } })
  if (!target) return res.status(404).json({ error: 'user not found' })

  const words = ['blue', 'ninja', 'rocket', 'orbit', 'sonic', 'cobra', 'lunar', 'quartz']
  const word = words[Math.floor(Math.random() * words.length)]
  const num = Math.floor(1000 + Math.random() * 9000)
  const newPassword = `${word}-${num}`

  await prisma.user.update({
    where: { id: req.params.id },
    data: { passwordHash: await hashPassword(newPassword) },
  })

  await recordAudit({
    actor: req.user!.email,
    action: 'user.password_reset',
    target: target.email,
  })

  return res.json({ ok: true, newPassword })
})
