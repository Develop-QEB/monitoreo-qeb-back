import { Router, type Request, type Response } from 'express'
import { requireAuth } from '../middleware/auth'
import { verifyJwt } from '../lib/jwt'
import {
  dropletLogHub,
  getDropletStatus,
  startDropletTailers,
  DROPLET_SOURCES,
  restartDropletProcess,
  clearProxyCache,
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

// ------- Reiniciar un proceso (boton en la tarjeta) -------
// POST /droplet/restart/:source  (source = key de DROPLET_SOURCES: autosync | qeb-api)
dropletRouter.post('/restart/:source', requireAuth, async (req: Request, res: Response) => {
  const source = String(req.params.source)
  const src = DROPLET_SOURCES.find((s) => s.key === source)
  if (!src) return res.status(400).json({ error: 'fuente desconocida' })
  const r = await restartDropletProcess(src.pm2)
  res.status(r.ok ? 200 : 500).json({ ok: r.ok, pm2: src.pm2, output: r.output.slice(0, 1500) })
})

// ------- Limpiar cache del proxy SAP (solo aplica a qeb-api) -------
// POST /droplet/clear-cache/:group  (group = todo | cimu | trade)
const CACHE_GROUPS: Record<string, string[]> = {
  todo: [], // sin key = limpia todo el cache del proxy
  cimu: ['cuic', 'articulos'],
  trade: ['cuic-trade', 'articulos-trade'],
}
dropletRouter.post('/clear-cache/:group', requireAuth, async (req: Request, res: Response) => {
  const group = String(req.params.group)
  const keys = CACHE_GROUPS[group]
  if (!keys) return res.status(400).json({ error: 'grupo desconocido' })
  if (keys.length === 0) {
    const r = await clearProxyCache()
    return res.status(r.ok ? 200 : 502).json({ ok: r.ok, cleared: 'todo', detail: r.body })
  }
  const results = []
  for (const k of keys) results.push({ key: k, ...(await clearProxyCache(k)) })
  res.status(results.every((x) => x.ok) ? 200 : 502).json({
    ok: results.every((x) => x.ok),
    cleared: group,
    results,
  })
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

  // Replay al conectar: el ring (por fuente, acotado y con hora real de cada
  // linea) para que cada consola muestre su historia reciente aunque la otra
  // fuente sea muy habladora. Lo nuevo sigue llegando por el evento 'line'.
  for (const line of dropletLogHub.recent()) {
    res.write(`data: ${JSON.stringify(line)}\n\n`)
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
