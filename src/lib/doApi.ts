import { env } from '../config/env'

/**
 * Cliente DigitalOcean API v2. Docs: https://docs.digitalocean.com/reference/api/
 * Requiere: DO_API_TOKEN. Endpoints específicos requieren APP_ID / CLUSTER_ID.
 */

const BASE = 'https://api.digitalocean.com/v2'

export function doApiConfigured(): boolean {
  return !!env.DO_API_TOKEN
}
export function doAppConfigured(): boolean {
  return !!(env.DO_API_TOKEN && env.DO_APP_ID_QEB_BACK)
}
export function doDbConfigured(): boolean {
  return !!(env.DO_API_TOKEN && env.DO_DB_CLUSTER_ID)
}

async function doFetch(path: string): Promise<unknown> {
  if (!env.DO_API_TOKEN) throw new Error('DO_API_TOKEN no configurado')
  const res = await fetch(BASE + path, {
    headers: {
      Authorization: `Bearer ${env.DO_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`digitalocean ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

// ------- Apps -------

export interface DoAppDeployment {
  id: string
  cause: string
  phase: string // PENDING_BUILD | BUILDING | DEPLOYING | ACTIVE | ERROR | CANCELED
  progress?: {
    success_steps: number
    error_steps: number
    total_steps: number
  }
  created_at: string
  updated_at: string
  cloned_from?: string
}

export async function getDoAppDeployments(limit = 10): Promise<DoAppDeployment[]> {
  const data = (await doFetch(
    `/apps/${env.DO_APP_ID_QEB_BACK!}/deployments?per_page=${limit}`,
  )) as { deployments: DoAppDeployment[] }
  return data.deployments ?? []
}

export interface DoAppInfo {
  id: string
  spec: { name: string; region: string }
  active_deployment?: DoAppDeployment
  in_progress_deployment?: DoAppDeployment
  live_url?: string
  region?: { slug: string; label: string }
  tier_slug?: string
}

export async function getDoAppInfo(): Promise<DoAppInfo> {
  const data = (await doFetch(`/apps/${env.DO_APP_ID_QEB_BACK!}`)) as { app: DoAppInfo }
  return data.app
}

// ------- Managed Databases -------

export interface DoDbClusterInfo {
  id: string
  name: string
  engine: string
  version: string
  status: string
  size: string
  region: string
  num_nodes: number
  db_names?: string[]
  connection?: {
    host: string
    port: number
    database: string
    ssl: boolean
  }
  created_at: string
}

export async function getDoDbCluster(): Promise<DoDbClusterInfo> {
  const data = (await doFetch(
    `/databases/${env.DO_DB_CLUSTER_ID!}`,
  )) as { database: DoDbClusterInfo }
  return data.database
}

// ------- App Metrics (CPU, Memory) via monitoring API -------

export type AppMetricName =
  | 'cpu_percentage'
  | 'memory_percentage'
  | 'restart_count'

interface PromResult {
  metric: Record<string, string>
  values: [number, string][] // [unix_ts, "0.42"]
}

export interface AppMetricSeries {
  component: string
  points: { ts: number; value: number }[]
  latest: number | null
  avg: number | null
  peak: number | null
}

// ------- App Runtime Logs -------

interface AppLogsUrlsResponse {
  historic_urls?: string[]
  live_url?: string
}

export interface AppLogLine {
  ts: string | null
  raw: string
}

export async function fetchDoAppRuntimeLogs(maxLines = 300): Promise<AppLogLine[]> {
  // 1) Pedir a DO las URLs firmadas de los logs
  const meta = (await doFetch(
    `/apps/${env.DO_APP_ID_QEB_BACK!}/logs?type=RUN&follow=false`,
  )) as AppLogsUrlsResponse

  if (!meta.historic_urls?.length) return []

  // 2) Bajar los últimos 2 chunks (por si el actual está vacio)
  const urls = meta.historic_urls.slice(-2)
  const bodies = await Promise.all(
    urls.map(async (u) => {
      try {
        const r = await fetch(u)
        if (!r.ok) return ''
        return await r.text()
      } catch {
        return ''
      }
    }),
  )
  const full = bodies.join('\n')

  // 3) Parsear línea por línea con timestamp
  const tsRegex = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(.*)$/
  const lines = full
    .split('\n')
    .map<AppLogLine>((raw) => {
      const m = tsRegex.exec(raw)
      return m ? { ts: m[1], raw: m[2] } : { ts: null, raw }
    })
    .filter((l) => l.raw.trim().length > 0)

  // 4) Últimas maxLines
  return lines.slice(-maxLines)
}

export async function getDoAppMetrics(
  metric: AppMetricName,
  hoursBack = 1,
): Promise<AppMetricSeries[]> {
  const end = Math.floor(Date.now() / 1000)
  const start = end - hoursBack * 3600
  const qs = new URLSearchParams({
    app_id: env.DO_APP_ID_QEB_BACK!,
    start: String(start),
    end: String(end),
  })
  const data = (await doFetch(`/monitoring/metrics/apps/${metric}?${qs}`)) as {
    data?: { result?: PromResult[] }
  }
  const results = data.data?.result ?? []
  return results.map((r) => {
    const points = r.values.map(([ts, v]) => ({ ts, value: Number(v) }))
    const values = points.map((p) => p.value)
    return {
      component: r.metric.app_component ?? r.metric.component ?? 'app',
      points,
      latest: values.length ? values[values.length - 1] : null,
      avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
      peak: values.length ? Math.max(...values) : null,
    }
  })
}
