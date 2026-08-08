import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { verifyPassword } from '../lib/password'
import { signJwt } from '../lib/jwt'
import { requireAuth } from '../middleware/auth'
import { recordAudit } from '../middleware/audit'

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export const authRouter: Router = Router()

authRouter.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'email y password requeridos' })
  }
  const { email, password } = parsed.data

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } })

  if (!user) {
    await recordAudit({
      actor: email.toLowerCase(),
      action: 'auth.login_fail',
      target: email.toLowerCase(),
      details: 'user not found',
    })
    return res.status(401).json({ error: 'credenciales inválidas' })
  }

  if (!user.active) {
    await recordAudit({
      actor: user.email,
      action: 'auth.login_fail',
      target: user.email,
      details: 'user disabled',
    })
    return res.status(403).json({ error: 'usuario deshabilitado' })
  }

  const ok = await verifyPassword(password, user.passwordHash)
  if (!ok) {
    await recordAudit({
      actor: user.email,
      action: 'auth.login_fail',
      target: user.email,
      details: 'bad password',
    })
    return res.status(401).json({ error: 'credenciales inválidas' })
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  })

  await recordAudit({
    actor: user.email,
    action: 'auth.login',
    target: user.email,
  })

  const token = signJwt({ sub: user.id, email: user.email, role: user.role })

  return res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  })
})

authRouter.post('/logout', requireAuth, async (req: Request, res: Response) => {
  await recordAudit({
    actor: req.user!.email,
    action: 'auth.logout',
    target: req.user!.email,
  })
  return res.json({ ok: true })
})

authRouter.get('/me', requireAuth, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.sub } })
  if (!user) return res.status(404).json({ error: 'user not found' })
  return res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  })
})
