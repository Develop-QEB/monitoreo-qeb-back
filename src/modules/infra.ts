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
    const lines = await fetchDoAppRuntimeLogs(maxLines)
    return res.json({ configured: true, count: lines.length, lines })
  } catch (err) {
    return res.status(500).json({ configured: true, error: (err as Error).message })
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
