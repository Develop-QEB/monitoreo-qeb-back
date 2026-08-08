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
