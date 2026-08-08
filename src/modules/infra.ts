import { Router, type Request, type Response } from 'express'
import { requireAuth } from '../middleware/auth'
import {
  listVercelDeployments,
  getVercelProject,
  vercelConfigured,
} from '../lib/vercelApi'
import {
  getDoAppDeployments,
  getDoAppInfo,
  getDoDbCluster,
  getDoAppMetrics,
  fetchDoAppRuntimeLogs,
  doApiConfigured,
  doAppConfigured,
  doDbConfigured,
  type AppMetricName,
} from '../lib/doApi'
import { streamAndCapture } from '../lib/logsCapture'
import { verifyJwt } from '../lib/jwt'
import { prisma } from '../lib/prisma'

export const infraRouter: Router = Router()

infraRouter.use(requireAuth)

// ------- VERCEL (front prod) -------

infraRouter.get('/vercel/deployments', async (_req: Request, res: Response) => {
  if (!vercelConfigured()) {
    return res.json({
      configured: false,
      reason: 'faltan VERCEL_TOKEN o VERCEL_PROJECT_ID en el env del back',
      deployments: [],
    })
  }
  try {
    const deployments = await listVercelDeployments(10)
    return res.json({ configured: true, deployments })
  } catch (err) {
    return res.status(500).json({ configured: true, error: (err as Error).message })
  }
})

infraRouter.get('/vercel/project', async (_req: Request, res: Response) => {
  if (!vercelConfigured()) {
    return res.json({ configured: false, reason: 'faltan VERCEL_TOKEN o VERCEL_PROJECT_ID' })
  }
  try {
    const project = await getVercelProject()
    return res.json({ configured: true, project })
  } catch (err) {
    return res.status(500).json({ configured: true, error: (err as Error).message })
  }
})

// ------- DIGITALOCEAN APP (qeb-back) -------

infraRouter.get('/do/app', async (_req: Request, res: Response) => {
  if (!doAppConfigured()) {
    return res.json({
      configured: false,
      reason: 'faltan DO_API_TOKEN o DO_APP_ID_QEB_BACK en el env del back',
    })
  }
  try {
    const app = await getDoAppInfo()
    return res.json({ configured: true, app })
  } catch (err) {
    return res.status(500).json({ configured: true, error: (err as Error).message })
  }
})

infraRouter.get('/do/app/deployments', async (_req: Request, res: Response) => {
  if (!doAppConfigured()) {
    return res.json({
      configured: false,
      reason: 'faltan DO_API_TOKEN o DO_APP_ID_QEB_BACK',
      deployments: [],
    })
  }
  try {
    const deployments = await getDoAppDeployments(10)
    return res.json({ configured: true, deployments })
  } catch (err) {
    return res.status(500).json({ configured: true, error: (err as Error).message })
  }
})

infraRouter.get('/do/app/metrics', async (req: Request, res: Response) => {
  if (!doAppConfigured()) {
    return res.json({
      configured: false,
      reason: 'faltan DO_API_TOKEN o DO_APP_ID_QEB_BACK',
      series: [],
    })
  }
  const metric = String(req.query.metric ?? 'cpu_percentage') as AppMetricName
  const validMetrics: AppMetricName[] = ['cpu_percentage', 'memory_percentage', 'restart_count']
  if (!validMetrics.includes(metric)) {
    return res.status(400).json({ error: 'metric inválida' })
  }
  const hours = Math.min(Math.max(parseInt(String(req.query.hours ?? '1'), 10) || 1, 1), 24)
  try {
    const series = await getDoAppMetrics(metric, hours)
    return res.json({ configured: true, metric, hours, series })
  } catch (err) {
    return res.status(500).json({ configured: true, error: (err as Error).message })
  }
})

infraRouter.get('/do/app/logs', async (req: Request, res: Response) => {
  if (!doAppConfigured()) {
    return res.json({
      configured: false,
      reason: 'faltan DO_API_TOKEN o DO_APP_ID_QEB_BACK',
      lines: [],
    })
  }
  const maxLines = Math.min(
    Math.max(parseInt(String(req.query.max ?? '300'), 10) || 300, 20),
    1000,
  )
  try {
    const { lines, debug } = await fetchDoAppRuntimeLogs(maxLines)
    return res.json({ configured: true, count: lines.length, lines, debug })
  } catch (err) {
    return res.status(500).json({ configured: true, error: (err as Error).message })
  }
})

// SSE: streaming en vivo desde DO live_url + captura a monitor_logs.
// EventSource no permite headers, así que aceptamos el JWT como ?token.
infraRouter.get('/do/app/logs/live', async (req: Request, res: Response) => {
  if (!doAppConfigured()) {
    return res.status(400).json({ configured: false })
  }

  // Auth por query param (EventSource no soporta headers)
  const token = String(req.query.token ?? '')
  try {
    verifyJwt(token)
  } catch {
    return res.status(401).json({ error: 'token invalido' })
  }

  // Headers SSE
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  res.write(': stream inicializado\n\n') // comentario keep-alive

  const ac = new AbortController()
  req.on('close', () => ac.abort())
  req.on('aborted', () => ac.abort())

  // ping cada 20s para mantener la conexión viva contra proxies
  const pingId = setInterval(() => {
    if (!ac.signal.aborted) res.write(': ping\n\n')
  }, 20_000)

  try {
    for await (const line of streamAndCapture(ac.signal)) {
      if (ac.signal.aborted) break
      res.write(`data: ${JSON.stringify(line)}\n\n`)
    }
  } catch (err) {
    if (!ac.signal.aborted) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ error: (err as Error).message })}\n\n`,
      )
    }
  } finally {
    clearInterval(pingId)
    if (!res.writableEnded) res.end()
  }
})

// Consulta histórica desde nuestra propia tabla monitor_logs.
infraRouter.get('/do/app/logs/db', async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '200'), 10) || 200, 20), 1000)
  const level = req.query.level ? String(req.query.level) : undefined
  const search = req.query.q ? String(req.query.q) : undefined
  const fromStr = req.query.from ? String(req.query.from) : undefined
  const toStr = req.query.to ? String(req.query.to) : undefined
  const from = fromStr && !isNaN(Date.parse(fromStr)) ? new Date(fromStr) : undefined
  const to = toStr && !isNaN(Date.parse(toStr)) ? new Date(toStr) : undefined

  try {
    const rows = await prisma.logEntry.findMany({
      where: {
        source: 'qeb-back',
        ...(level ? { level } : {}),
        ...(search ? { msg: { contains: search } } : {}),
        ...(from || to
          ? {
              ts: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      orderBy: { ts: 'desc' },
      take: limit,
      select: { id: true, ts: true, level: true, msg: true },
    })
    return res.json({ count: rows.length, lines: rows.reverse() })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

// Contexto de una línea de log: N líneas antes y N después, sin filtros.
infraRouter.get('/do/app/logs/db/:id/context', async (req: Request<{ id: string }>, res: Response) => {
  const contextSize = Math.min(
    Math.max(parseInt(String(req.query.size ?? '20'), 10) || 20, 5),
    100,
  )
  try {
    const target = await prisma.logEntry.findUnique({
      where: { id: req.params.id },
      select: { id: true, ts: true, level: true, msg: true },
    })
    if (!target) return res.status(404).json({ error: 'línea no encontrada' })

    const before = await prisma.logEntry.findMany({
      where: {
        source: 'qeb-back',
        OR: [
          { ts: { lt: target.ts } },
          { AND: [{ ts: target.ts }, { id: { lt: target.id } }] },
        ],
      },
      orderBy: [{ ts: 'desc' }, { id: 'desc' }],
      take: contextSize,
      select: { id: true, ts: true, level: true, msg: true },
    })
    const after = await prisma.logEntry.findMany({
      where: {
        source: 'qeb-back',
        OR: [
          { ts: { gt: target.ts } },
          { AND: [{ ts: target.ts }, { id: { gt: target.id } }] },
        ],
      },
      orderBy: [{ ts: 'asc' }, { id: 'asc' }],
      take: contextSize,
      select: { id: true, ts: true, level: true, msg: true },
    })

    return res.json({
      target,
      context: [...before.reverse(), target, ...after],
    })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

infraRouter.get('/do/app/logs/db/stats', async (_req: Request, res: Response) => {
  try {
    const total = await prisma.logEntry.count({ where: { source: 'qeb-back' } })
    const byLevel = await prisma.logEntry.groupBy({
      by: ['level'],
      where: { source: 'qeb-back' },
      _count: { _all: true },
    })
    const first = await prisma.logEntry.findFirst({
      where: { source: 'qeb-back' },
      orderBy: { ts: 'asc' },
      select: { ts: true },
    })
    const last = await prisma.logEntry.findFirst({
      where: { source: 'qeb-back' },
      orderBy: { ts: 'desc' },
      select: { ts: true },
    })
    return res.json({
      total,
      by_level: byLevel.map((b) => ({ level: b.level, count: b._count._all })),
      first_at: first?.ts ?? null,
      last_at: last?.ts ?? null,
    })
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message })
  }
})

// ------- DIGITALOCEAN MANAGED DATABASE (qeb-mysql-prod) -------

infraRouter.get('/do/database', async (_req: Request, res: Response) => {
  if (!doDbConfigured()) {
    return res.json({
      configured: false,
      reason: 'faltan DO_API_TOKEN o DO_DB_CLUSTER_ID',
    })
  }
  try {
    const cluster = await getDoDbCluster()
    return res.json({ configured: true, cluster })
  } catch (err) {
    return res.status(500).json({ configured: true, error: (err as Error).message })
  }
})

// ------- CONFIG SUMMARY -------
// Endpoint para saber qué integraciones están activas desde el front.

infraRouter.get('/config', (_req: Request, res: Response) => {
  return res.json({
    vercel: vercelConfigured(),
    doApi: doApiConfigured(),
    doApp: doAppConfigured(),
    doDb: doDbConfigured(),
  })
})
