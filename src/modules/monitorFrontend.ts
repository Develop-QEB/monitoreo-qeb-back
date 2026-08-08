import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma'

export const monitorFrontendRouter: Router = Router()

const errorSchema = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().max(20000).optional(),
  url: z.string().max(500).optional(),
  userAgent: z.string().max(500).optional(),
  userEmail: z.string().email().max(190).optional(),
  errorType: z.enum(['boundary', 'window.onerror', 'unhandledrejection']).optional(),
})

// Sin auth explicita — cualquiera que reviente en admin.qeb.mx debe poder
// reportar (incluyendo usuarios no logueados). CORS ya limita al front oficial.
monitorFrontendRouter.post('/front-error', async (req: Request, res: Response) => {
  const parsed = errorSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'payload invalido' })

  const { message, stack, url, userAgent, userEmail, errorType } = parsed.data
  const meta = {
    url,
    userAgent,
    userEmail,
    errorType: errorType ?? 'unknown',
    stack: stack?.slice(0, 8000),
  }

  try {
    await prisma.logEntry.create({
      data: {
        ts: new Date(),
        source: 'monitor-front',
        level: 'ERROR',
        msg: message.slice(0, 65000),
        meta: JSON.stringify(meta).slice(0, 65000),
        requestId: userEmail ?? null,
      },
    })
    return res.json({ ok: true })
  } catch (err) {
    console.error('[/front-error]', err)
    return res.status(500).json({ error: (err as Error).message })
  }
})
