import type { NextFunction, Request, Response } from 'express'

export function notFound(_req: Request, res: Response) {
  return res.status(404).json({ error: 'not found' })
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  console.error('[error]', err)
  const msg = err instanceof Error ? err.message : 'internal error'
  return res.status(500).json({ error: msg })
}
