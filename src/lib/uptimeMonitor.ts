import { Socket } from 'node:net'
import { performance } from 'node:perf_hooks'
import { prisma } from './prisma'
import { env } from '../config/env'

// Ping cada N segundos a los 3 targets y persistir en monitor_uptime_pings.
// La URL real del back QEB nunca sale de este proceso: se resuelve via API de
// DO usando DO_APP_ID_QEB_BACK y se cachea en RAM. Los endpoints del front
// solo devuelven metricas agregadas por target ('front-qeb' | 'back-qeb' | 'db-qeb').

const PING_INTERVAL_MS = 60_000
const HTTP_TIMEOUT_MS = 8_000
const TCP_TIMEOUT_MS = 5_000
const BACK_URL_CACHE_MS = 10 * 60_000

// Extrae host:port de una connection string mysql:// (para el ping TCP a la DB).
function parseMysqlHostPort(url: string | undefined): { host: string; port: number } | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (!u.hostname) return null
    const port = u.port ? Number(u.port) : 3306
    return { host: u.hostname, port }
  } catch {
    return null
  }
}

let backUrlCache: { url: string | null; at: number } = { url: null, at: 0 }

async function resolveBackQebUrl(): Promise<string | null> {
  const now = Date.now()
  if (backUrlCache.url && now - backUrlCache.at < BACK_URL_CACHE_MS) {
    return backUrlCache.url
  }
  if (!env.DO_API_TOKEN || !env.DO_APP_ID_QEB_BACK) return null
  try {
    const r = await fetch(`https://api.digitalocean.com/v2/apps/${env.DO_APP_ID_QEB_BACK}`, {
      headers: { Authorization: `Bearer ${env.DO_API_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) return null
    const j = (await r.json()) as { app?: { live_url?: string } }
    const live = j.app?.live_url ?? null
    backUrlCache = { url: live, at: now }
    return live
  } catch {
    return null
  }
}

interface PingResult {
  ok: boolean
  responseMs: number
  status: number | null
  error: string | null
}

async function pingHttp(url: string): Promise<PingResult> {
  const t0 = performance.now()
  try {
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      // No mandamos cookies ni auth; solo queremos ver que el servidor responde.
    })
    const dt = Math.round(performance.now() - t0)
    return { ok: r.status < 500, responseMs: dt, status: r.status, error: null }
  } catch (e) {
    const dt = Math.round(performance.now() - t0)
    return {
      ok: false,
      responseMs: dt,
      status: null,
      error: (e as Error).message.slice(0, 200),
    }
  }
}

function pingTcp(host: string, port: number): Promise<PingResult> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const s = new Socket()
    let done = false
    const finish = (r: PingResult) => {
      if (done) return
      done = true
      s.destroy()
      resolve(r)
    }
    s.setTimeout(TCP_TIMEOUT_MS)
    s.once('connect', () => {
      finish({ ok: true, responseMs: Math.round(performance.now() - t0), status: null, error: null })
    })
    s.once('timeout', () => {
      finish({ ok: false, responseMs: TCP_TIMEOUT_MS, status: null, error: 'timeout' })
    })
    s.once('error', (e) => {
      finish({
        ok: false,
        responseMs: Math.round(performance.now() - t0),
        status: null,
        error: e.message.slice(0, 200),
      })
    })
    s.connect(port, host)
  })
}

async function saveResult(target: string, kind: 'http' | 'tcp', r: PingResult): Promise<void> {
  try {
    await prisma.uptimePing.create({
      data: {
        target,
        kind,
        ok: r.ok,
        responseMs: r.responseMs,
        status: r.status,
        error: r.error,
      },
    })
  } catch {
    // La DB del monitor puede estar caida; no relanzamos para no matar el interval.
  }
}

async function runRound(): Promise<void> {
  const dbTarget = parseMysqlHostPort(env.DATABASE_URL_QEB)
  const backUrl = await resolveBackQebUrl()

  const jobs: Promise<void>[] = []
  jobs.push(pingHttp('https://admin.qeb.mx').then((r) => saveResult('front-qeb', 'http', r)))
  if (backUrl) {
    jobs.push(pingHttp(backUrl).then((r) => saveResult('back-qeb', 'http', r)))
  }
  if (dbTarget) {
    jobs.push(pingTcp(dbTarget.host, dbTarget.port).then((r) => saveResult('db-qeb', 'tcp', r)))
  }
  await Promise.all(jobs)
}

let started = false
let timer: NodeJS.Timeout | null = null

export function startUptimeMonitor(): void {
  if (started) return
  started = true
  // Kick inmediato para que haya al menos 1 dato al arranque, luego cada minuto.
  void runRound()
  timer = setInterval(() => {
    void runRound()
  }, PING_INTERVAL_MS)
}

export function stopUptimeMonitor(): void {
  if (timer) clearInterval(timer)
  timer = null
  started = false
}
