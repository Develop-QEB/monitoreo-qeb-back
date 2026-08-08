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
  // DO puede devolver `url` (un solo string firmado) o `historic_urls` (array),
  // dependiendo del endpoint. Manejamos ambos.
  url?: string
  historic_urls?: string[]
  live_url?: string
}

export interface AppLogLine {
  ts: string | null
  raw: string
}

export interface LogsFetchDebug {
  triedUrls: string[]
  historicCount: number
  fetchedBytes: number
  errors: string[]
}

async function tryLogsEndpoint(path: string, debug: LogsFetchDebug): Promise<string[]> {
  debug.triedUrls.push(path)
  try {
    const meta = (await doFetch(path)) as AppLogsUrlsResponse
    // Aceptar tanto `url` (single) como `historic_urls` (array)
    if (meta.historic_urls?.length) return meta.historic_urls
    if (meta.url) return [meta.url]
    return []
  } catch (e) {
    debug.errors.push(`${path} → ${(e as Error).message.slice(0, 100)}`)
    return []
  }
}

// Obtiene el live_url (HTTP chunked) para tailing en tiempo real.
export async function getDoAppLiveLogsUrl(): Promise<string | null> {
  try {
    const appInfo = await getDoAppInfo()
    const deploymentId = appInfo.active_deployment?.id
    const componentName = appInfo.spec?.name
    if (!deploymentId || !componentName) return null

    const meta = (await doFetch(
      `/apps/${env.DO_APP_ID_QEB_BACK!}/deployments/${deploymentId}/components/${componentName}/logs?type=RUN&follow=true`,
    )) as AppLogsUrlsResponse

    return meta.live_url ?? null
  } catch {
    return null
  }
}

export async function fetchDoAppRuntimeLogs(
  maxLines = 300,
): Promise<{ lines: AppLogLine[]; debug: LogsFetchDebug }> {
  const debug: LogsFetchDebug = {
    triedUrls: [],
    historicCount: 0,
    fetchedBytes: 0,
    errors: [],
  }

  // Necesitamos el deployment activo y el component name para máxima cobertura
  let deploymentId: string | undefined
  let componentName: string | undefined
  try {
    const appInfo = await getDoAppInfo()
    deploymentId = appInfo.active_deployment?.id
    componentName = appInfo.spec?.name
  } catch (e) {
    debug.errors.push(`getDoAppInfo → ${(e as Error).message.slice(0, 100)}`)
  }

  const appId = env.DO_APP_ID_QEB_BACK!
  let urls: string[] = []

  // 1) Intento con deployment + component (más específico, más historia)
  if (deploymentId && componentName) {
    urls = await tryLogsEndpoint(
      `/apps/${appId}/deployments/${deploymentId}/components/${componentName}/logs?type=RUN`,
      debug,
    )
  }
  // 2) Fallback deployment sin component
  if (!urls.length && deploymentId) {
    urls = await tryLogsEndpoint(
      `/apps/${appId}/deployments/${deploymentId}/logs?type=RUN`,
      debug,
    )
  }
  // 3) Fallback app-level con component
  if (!urls.length && componentName) {
    urls = await tryLogsEndpoint(
      `/apps/${appId}/components/${componentName}/logs?type=RUN`,
      debug,
    )
  }
  // 4) Fallback más amplio
  if (!urls.length) {
    urls = await tryLogsEndpoint(`/apps/${appId}/logs?type=RUN`, debug)
  }

  debug.historicCount = urls.length
  if (!urls.length) return { lines: [], debug }

  // Bajar los últimos 3 chunks
  const bodies = await Promise.all(
    urls.slice(-3).map(async (u) => {
      try {
        const r = await fetch(u)
        if (!r.ok) {
          debug.errors.push(`fetch ${r.status} on log chunk`)
          return ''
        }
        const t = await r.text()
        debug.fetchedBytes += t.length
        return t
      } catch (e) {
        debug.errors.push(`fetch fail: ${(e as Error).message.slice(0, 80)}`)
        return ''
      }
    }),
  )
  const full = bodies.join('\n')

  // Parsear cada línea. DO prefija con el nombre del componente
  // ("qeb-back") + timestamp ISO + mensaje (con códigos ANSI de morgan).
  //
  //   qeb-back 2026-08-08T03:49:45.051Z [0mGET /api/... [32m200[0m 70ms - 418[0m
  //   |_______| |___________________| |_________________________________________|
  //   componente     timestamp                  mensaje sucio
  const withPrefix = /^(?:[^\s]+\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(.*)$/
  // Códigos ANSI: pueden venir con o sin el byte de escape \x1b
  const ansiRegex = /\x1b?\[[\d;]*m/g

  const lines = full
    .split('\n')
    .map<AppLogLine>((raw) => {
      const m = withPrefix.exec(raw)
      const ts = m ? m[1] : null
      const msg = (m ? m[2] : raw).replace(ansiRegex, '').trim()
      return { ts, raw: msg }
    })
    .filter((l) => l.raw.length > 0)

  return { lines: lines.slice(-maxLines), debug }
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
