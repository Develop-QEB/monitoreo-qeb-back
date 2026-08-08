import type { NextFunction, Request, Response } from 'express'
import { verifyJwt, type JwtPayload } from '../lib/jwt'

declare module 'express-serve-static-core' {
  interface Request {
    user?: JwtPayload
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing bearer token' })
  }
  try {
    req.user = verifyJwt(header.slice(7))
    return next()
  } catch {
    return res.status(401).json({ error: 'invalid or expired token' })
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' })
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden', role: req.user.role })
    }
    return next()
  }
}
