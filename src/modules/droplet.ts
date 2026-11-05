import { Router, type Request, type Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { verifyJwt } from '../lib/jwt'
import {
  dropletLogHub,
  getDropletStatus,
  startDropletTailers,
  DROPLET_SOURCES,
} from '../lib/dropletLogs'
import type { VpsLogLine } from '../lib/vpsLogHub'

export const dropletRouter: Router = Router()

// Arrancamos los tailers al cargar el modulo (una sola vez; es idempotente).
startDropletTailers()

// ------- Fuentes disponibles (para que el front arme las consolas) -------
dropletRouter.get('/sources', requireAuth, (_req: Request, res: Response) => {
  res.json({ sources: DROPLET_SOURCES })
})

// ------- Estado de cada proceso (para los marcadores verde/rojo) -------
dropletRouter.get('/status', requireAuth, async (_req: Request, res: Response) => {
  const procs = await getDropletStatus()
  res.json({ procs })
})

// ------- SSE en vivo (una sola conexion; cada linea trae su `source`) -------
// EventSource no manda headers, aceptamos el JWT como ?token (igual que el VPS).
dropletRouter.get('/logs/live', (req: Request, res: Response) => {
  const token = String(req.query.token ?? '')
  try {
    verifyJwt(token)
  } catch {
    return res.status(401).json({ error: 'token invalido' })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  res.write(': stream droplet inicializado\n\n')

  // Buffer reciente al conectar: SOLO lo de los ultimos minutos, para que la
  // consola se sienta "en vivo" y no vuelque historia vieja (hasta 600 lineas)
  // de golpe al abrir la tab. Lo nuevo sigue llegando por el evento 'line'.
  const REPLAY_MS = 5 * 60_000
  const cutoff = Date.now() - REPLAY_MS
  for (const line of dropletLogHub.recent()) {
    if (new Date(line.ts).getTime() >= cutoff) {
      res.write(`data: ${JSON.stringify(line)}\n\n`)
    }
  }

  const onLine = (line: VpsLogLine) => {
    res.write(`data: ${JSON.stringify(line)}\n\n`)
  }
  dropletLogHub.on('line', onLine)

  const pingId = setInterval(() => res.write(': ping\n\n'), 20_000)

  const cleanup = () => {
    clearInterval(pingId)
    dropletLogHub.off('line', onLine)
    if (!res.writableEnded) res.end()
  }
  req.on('close', cleanup)
  req.on('aborted', cleanup)
})
