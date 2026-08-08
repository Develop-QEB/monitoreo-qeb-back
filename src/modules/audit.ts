import { Router, type Request, type Response } from 'express'
import { prisma } from '../lib/prisma'
import { requireAuth, requireRole } from '../middleware/auth'

export type AuditActionKind =
  | 'auth.login'
  | 'auth.login_fail'
  | 'auth.logout'
  | 'user.create'
  | 'user.update'
  | 'user.delete'
  | 'user.role_change'
  | 'user.disable'
  | 'user.enable'
  | 'user.password_reset'
  | 'query.kill'
  | 'reserva.resolver'

export const auditRouter: Router = Router()

auditRouter.use(requireAuth)

auditRouter.get('/', requireRole('admin'), async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? '500'), 10) || 500, 1000)
  const action = req.query.action ? String(req.query.action) : undefined
  const actor = req.query.actor ? String(req.query.actor) : undefined

  const where = {
    ...(action ? { action } : {}),
    ...(actor ? { actor: { contains: actor } } : {}),
  }

  const events = await prisma.auditEvent.findMany({
    where,
    orderBy: { ts: 'desc' },
    take: limit,
  })

  return res.json({ events })
})
