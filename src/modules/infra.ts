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
import { bgCapture } from '../lib/backgroundCapture'
import { doSpacesConfigured, getSpacesSummary } from '../lib/doSpaces'
import { estimateAppPlan, estimateDbPlan } from '../lib/doPricing'

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
    // DO expone el precio real via spec.services[].instance_size_slug (por servicio),
    // no via tier_slug root (que solo dice familia como "professional"). Sumamos todos
    // los servicios definidos en la spec.
    const services = ((app as unknown as {
      spec?: { services?: { instance_size_slug?: string; instance_count?: number }[] }
    })?.spec?.services) ?? []
    let plan
    if (services.length === 0) {
      plan = estimateAppPlan(null, 1, app?.tier_slug)
    } else if (services.length === 1) {
      plan = estimateAppPlan(services[0].instance_size_slug, services[0].instance_count ?? 1, app?.tier_slug)
    } else {
      // App con varios servicios: sumar cada uno.
      const parts = services.map((s) =>
        estimateAppPlan(s.instance_size_slug, s.instance_count ?? 1, app?.tier_slug),
      )
      const total = parts.reduce((acc, p) => acc + (p.usdPerMonth ?? 0), 0)
      plan = {
        slug: parts.map((p) => p.slug).join(' + '),
        usdPerMonth: parts.every((p) => p.known) ? total : null,
        known: parts.every((p) => p.known),
      }
    }
    return res.json({ configured: true, app, plan })
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

// Estado del background capturer (útil para saber si 24/7 está corriendo)
infraRouter.get('/do/app/logs/capture', (_req: Request, res: Response) => {
  return res.json(bgCapture.status())
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
    const plan = estimateDbPlan(cluster?.size, cluster?.num_nodes ?? 1)
    return res.json({ configured: true, cluster, plan })
  } catch (err) {
    return res.status(500).json({ configured: true, error: (err as Error).message })
  }
})

// ------- DIGITALOCEAN SPACES (qeb-media-main) -------

infraRouter.get('/spaces/summary', async (_req: Request, res: Response) => {
  if (!doSpacesConfigured()) {
    return res.json({
      configured: false,
      reason: 'faltan DO_SPACES_KEY / DO_SPACES_SECRET / DO_SPACES_BUCKET',
    })
  }
  try {
    const summary = await getSpacesSummary()
    return res.json({ configured: true, ...summary })
  } catch (err) {
    return res.status(500).json({ configured: true, error: (err as Error).message })
  }
})

// ------- HISTORICO DE CPU/RAM (snapshot cada 5min desde el back) -------
// DO monitoring solo retiene 1h. Con esta tabla tenemos 30 dias. Sirve para
// investigar incidentes pasados ("hace 3 dias a las 4pm hubo un pico de CPU").

infraRouter.get('/do/app/metrics/history', async (req: Request, res: Response) => {
  const metric = String(req.query.metric ?? 'cpu')
  if (metric !== 'cpu' && metric !== 'ram') {
    return res.status(400).json({ error: 'metric debe ser cpu o ram' })
  }
  // Rango 1h..720h (30 dias). Default 24h.
  const hours = Math.max(1, Math.min(720, parseInt(String(req.query.hours ?? '24'), 10) || 24))
  const since = new Date(Date.now() - hours * 60 * 60_000)

  const rows = await prisma.metricSnapshot.findMany({
    where: { metric, ts: { gte: since } },
    orderBy: { ts: 'asc' },
    select: { ts: true, valuePct: true },
  })
  const values = rows.map((r) => r.valuePct)
  return res.json({
    metric,
    hours,
    count: rows.length,
    avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    peak: values.length ? Math.max(...values) : null,
    latest: values.length ? values[values.length - 1] : null,
    points: rows.map((r) => ({ ts: r.ts.toISOString(), value: r.valuePct })),
  })
})

// ------- UPTIME (pings propios cada 60s desde el back) -------
// NUNCA devolvemos hostnames / URLs de los targets: el front solo necesita
// saber `target` ('front-qeb' | 'back-qeb' | 'db-qeb'), no la URL real.

const UPTIME_TARGETS = ['front-qeb', 'back-qeb', 'db-qeb'] as const
type UptimeTarget = (typeof UPTIME_TARGETS)[number]
const TARGET_LABEL: Record<UptimeTarget, string> = {
  'front-qeb': 'frontend qeb',
  'back-qeb': 'backend qeb',
  'db-qeb': 'database qeb',
}

function pct(nOk: number, total: number): number {
  if (total === 0) return 0
  return Math.round((nOk / total) * 10000) / 100
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

infraRouter.get('/uptime/summary', async (req: Request, res: Response) => {
  const hours = Math.max(1, Math.min(168, parseInt(String(req.query.hours ?? '24'), 10) || 24))
  const since = new Date(Date.now() - hours * 60 * 60_000)

  const rows = await prisma.uptimePing.findMany({
    where: { ts: { gte: since } },
    select: { target: true, ok: true, responseMs: true, ts: true, status: true },
  })
  const byTarget: Record<string, typeof rows> = {}
  for (const r of rows) {
    ;(byTarget[r.target] ??= []).push(r)
  }

  const targets = UPTIME_TARGETS.map((t) => {
    const list = byTarget[t] ?? []
    const okList = list.filter((r) => r.ok)
    const responseMs = okList.map((r) => r.responseMs)
    const avg =
      responseMs.length === 0
        ? null
        : Math.round(responseMs.reduce((a, b) => a + b, 0) / responseMs.length)
    const last = list[list.length - 1] ?? null
    return {
      key: t,
      name: TARGET_LABEL[t],
      count: list.length,
      okCount: okList.length,
      uptimePct: pct(okList.length, list.length),
      avgMs: avg,
      p95Ms: percentile(responseMs, 95),
      lastPingAt: last ? last.ts.toISOString() : null,
      lastOk: last ? last.ok : null,
      lastStatus: last?.status ?? null,
    }
  })

  return res.json({ hours, targets })
})

infraRouter.get('/uptime/series', async (req: Request, res: Response) => {
  const target = String(req.query.target ?? '')
  if (!(UPTIME_TARGETS as readonly string[]).includes(target)) {
    return res.status(400).json({ error: 'target invalido' })
  }
  const hours = Math.max(1, Math.min(168, parseInt(String(req.query.hours ?? '24'), 10) || 24))
  const since = new Date(Date.now() - hours * 60 * 60_000)

  const rows = await prisma.uptimePing.findMany({
    where: { target, ts: { gte: since } },
    orderBy: { ts: 'asc' },
    select: { ts: true, ok: true, responseMs: true, status: true },
  })
  return res.json({
    target,
    hours,
    points: rows.map((r) => ({
      ts: r.ts.toISOString(),
      ok: r.ok,
      responseMs: r.responseMs,
      status: r.status,
    })),
  })
})

// ------- CONFIG SUMMARY -------
// Endpoint para saber qué integraciones están activas desde el front.

infraRouter.get('/config', (_req: Request, res: Response) => {
  return res.json({
    vercel: vercelConfigured(),
    doApi: doApiConfigured(),
    doApp: doAppConfigured(),
    doDb: doDbConfigured(),
    doSpaces: doSpacesConfigured(),
  })
})
