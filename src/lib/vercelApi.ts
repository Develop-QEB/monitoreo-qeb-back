import { env } from '../config/env'

/**
 * Cliente Vercel API. Docs: https://vercel.com/docs/rest-api
 * Requiere: VERCEL_TOKEN + VERCEL_PROJECT_ID (opcionalmente VERCEL_TEAM_ID).
 */

const BASE = 'https://api.vercel.com'

export function vercelConfigured(): boolean {
  return !!(env.VERCEL_TOKEN && env.VERCEL_PROJECT_ID)
}

async function vercelFetch(path: string): Promise<unknown> {
  if (!env.VERCEL_TOKEN) throw new Error('VERCEL_TOKEN no configurado')
  const url = new URL(BASE + path)
  if (env.VERCEL_TEAM_ID) url.searchParams.set('teamId', env.VERCEL_TEAM_ID)
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`vercel ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

export interface VercelDeployment {
  uid: string
  name: string
  url: string
  state: string
  meta: Record<string, string>
  target: string | null
  source: string
  createdAt: number
  buildingAt?: number
  ready?: number
  creator: { username: string; email?: string }
}

export async function listVercelDeployments(limit = 10): Promise<VercelDeployment[]> {
  const qs = new URLSearchParams({
    projectId: env.VERCEL_PROJECT_ID!,
    limit: String(limit),
  })
  const data = (await vercelFetch(`/v6/deployments?${qs.toString()}`)) as {
    deployments: VercelDeployment[]
  }
  return data.deployments ?? []
}

export interface VercelProjectInfo {
  id: string
  name: string
  framework: string | null
  targets?: {
    production?: { alias?: string[] }
  }
}

export async function getVercelProject(): Promise<VercelProjectInfo> {
  const data = (await vercelFetch(
    `/v9/projects/${env.VERCEL_PROJECT_ID!}`,
  )) as VercelProjectInfo
  return data
}
