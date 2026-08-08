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

const patchUserSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().optional(),
  role: z.enum(ROLES).optional(),
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

// update general — admin only. Cambia name, email y/o role en una sola operación.
usersRouter.patch('/:id', requireRole('admin'), async (req: Request<{ id: string }>, res: Response) => {
  const parsed = patchUserSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'payload inválido' })

  const target = await prisma.user.findUnique({ where: { id: req.params.id } })
  if (!target) return res.status(404).json({ error: 'user not found' })

  const patch = parsed.data
  if (patch.email && patch.email.toLowerCase() !== target.email.toLowerCase()) {
    const exists = await prisma.user.findUnique({
      where: { email: patch.email.toLowerCase().trim() },
    })
    if (exists) return res.status(409).json({ error: 'email ya registrado' })
    patch.email = patch.email.toLowerCase().trim()
  }

  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: patch,
    select: {
      id: true, name: true, email: true, role: true, active: true, createdAt: true, lastLoginAt: true,
    },
  })

  const changes: string[] = []
  if (patch.name  && patch.name  !== target.name)  changes.push(`name: ${target.name} → ${user.name}`)
  if (patch.email && patch.email !== target.email) changes.push(`email: ${target.email} → ${user.email}`)
  if (patch.role  && patch.role  !== target.role)  changes.push(`role: ${target.role} → ${user.role}`)

  await recordAudit({
    actor: req.user!.email,
    action: 'user.update',
    target: user.email,
    details: changes.join(' · ') || 'sin cambios efectivos',
  })

  return res.json({ user })
})

// hard delete — admin only. Borra en firme (el audit trail conserva el email como referencia).
usersRouter.delete('/:id', requireRole('admin'), async (req: Request<{ id: string }>, res: Response) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } })
  if (!target) return res.status(404).json({ error: 'user not found' })
  if (target.email.toLowerCase() === req.user!.email.toLowerCase()) {
    return res.status(400).json({ error: 'no puedes borrar tu propia cuenta' })
  }

  await prisma.user.delete({ where: { id: req.params.id } })

  await recordAudit({
    actor: req.user!.email,
    action: 'user.delete',
    target: target.email,
    details: `role=${target.role}`,
  })

  return res.json({ ok: true })
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
