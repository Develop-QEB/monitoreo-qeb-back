import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { timingSafeEqual } from 'node:crypto'
import { requireAuth } from '../middleware/auth'
import { verifyJwt } from '../lib/jwt'
import { env } from '../config/env'
import { vpsLogHub, detectLevel, type VpsLogLine, type LogLevel } from '../lib/vpsLogHub'

export const vpsRouter: Router = Router()

function vpsConfigured(): boolean {
  return Boolean(env.VPS_LOG_SECRET)
}

// Comparación en tiempo constante para no filtrar el secreto por timing.
function secretOk(provided: string | undefined): boolean {
  const expected = env.VPS_LOG_SECRET
  if (!expected || !provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const levelEnum = z.enum(['INFO', 'WARN', 'ERROR', 'DEBUG'])

const lineSchema = z.object({
  ts: z.string().optional(),
  msg: z.string().min(1).max(65000),
  level: levelEnum.optional(),
})

// Acepta un batch { lines: [...] } o una línea suelta { msg, ts?, level? }.
const ingestSchema = z.object({
  source: z.string().max(120).optional(),
  lines: z.array(lineSchema).max(500).optional(),
  ts: z.string().optional(),
  msg: z.string().min(1).max(65000).optional(),
  level: levelEnum.optional(),
})

// ------- INGESTA (desde el agente PowerShell del VPS) -------
// Auth por SECRETO COMPARTIDO en header (x-vps-secret), NO por JWT: el VPS no
// es un usuario logueado, es una máquina empujando logs.
vpsRouter.post('/logs/ingest', (req: Request, res: Response) => {
  if (!vpsConfigured()) {
    return res.status(503).json({ error: 'VPS_LOG_SECRET no configurado en el back' })
  }
  if (!secretOk(req.header('x-vps-secret') ?? undefined)) {
    return res.status(401).json({ error: 'secreto invalido' })
  }

  const parsed = ingestSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'payload invalido', detail: parsed.error.issues })
  }
  const body = parsed.data
  const source = (body.source ?? 'vps').slice(0, 120)

  const raw = body.lines ?? (body.msg ? [{ ts: body.ts, msg: body.msg, level: body.level }] : [])
  if (raw.length === 0) {
    return res.status(400).json({ error: 'sin lineas' })
  }

  let received = 0
  for (const l of raw) {
    const level: LogLevel = l.level ?? detectLevel(l.msg)
    const ts =
      l.ts && !isNaN(Date.parse(l.ts)) ? new Date(l.ts).toISOString() : new Date().toISOString()
    const line: VpsLogLine = { ts, msg: l.msg.slice(0, 65000), level, source }
    vpsLogHub.push(line)
    received++
  }
  return res.json({ ok: true, received })
})

// ------- SSE en vivo (para el navegador) -------
// EventSource no permite mandar headers, así que aceptamos el JWT como ?token.
vpsRouter.get('/logs/live', (req: Request, res: Response) => {
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
  res.write(': stream vps inicializado\n\n')

  // Al conectar, mandamos el buffer reciente para dar contexto inmediato.
  for (const line of vpsLogHub.recent()) {
    res.write(`data: ${JSON.stringify(line)}\n\n`)
  }

  const onLine = (line: VpsLogLine) => {
    res.write(`data: ${JSON.stringify(line)}\n\n`)
  }
  vpsLogHub.on('line', onLine)

  // ping cada 20s para mantener viva la conexión contra proxies.
  const pingId = setInterval(() => res.write(': ping\n\n'), 20_000)

  const cleanup = () => {
    clearInterval(pingId)
    vpsLogHub.off('line', onLine)
    if (!res.writableEnded) res.end()
  }
  req.on('close', cleanup)
  req.on('aborted', cleanup)
})

// ------- Estado (para el header/badge de la tab) -------
vpsRouter.get('/logs/status', requireAuth, (_req: Request, res: Response) => {
  const last = vpsLogHub.lastLineAt
  // "conectado" = recibimos algo del agente en el último minuto.
  const connected = last != null && Date.now() - last < 60_000
  return res.json({
    configured: vpsConfigured(),
    connected,
    lastLineAt: last ? new Date(last).toISOString() : null,
    buffered: vpsLogHub.buffered,
  })
})
