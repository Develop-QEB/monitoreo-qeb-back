import { prisma } from './prisma'
import { getDoAppLiveLogsUrl } from './doApi'

/**
 * Se conecta al live_url de DigitalOcean (HTTP chunked, keep-alive) y
 * emite cada línea de log conforme llega. ADEMÁS de emitirla al consumidor,
 * la persiste en `dashboard_dev.monitor_logs` (tabla LogEntry de Prisma).
 *
 * Cuando el AbortSignal se dispara (ej. cliente SSE cierra), corta.
 */

export interface CapturedLine {
  ts: string | null
  msg: string
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'
}

const ansiRegex = /\x1b?\[[\d;]*m/g
const lineRegex = /^(?:[^\s]+\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(.*)$/

function detectLevel(msg: string): CapturedLine['level'] {
  const u = msg.toUpperCase()
  if (u.includes('ERROR') || u.includes('EXCEPTION') || u.includes('ECONNREFUSED')) return 'ERROR'
  if (u.includes('WARN')) return 'WARN'
  if (u.includes('DEBUG')) return 'DEBUG'
  return 'INFO'
}

function parseLine(raw: string): CapturedLine | null {
  const m = lineRegex.exec(raw)
  const ts = m ? m[1] : null
  const rawMsg = m ? m[2] : raw
  const msg = rawMsg.replace(ansiRegex, '').trim()
  if (!msg) return null
  return { ts, msg, level: detectLevel(msg) }
}

// ---- BATCH BUFFER ----
// Antes se hacia 1 INSERT por linea con fire-and-forget. Con el back de QEB
// generando 200-300 lineas/min y latencia local-a-DO de ~150ms, el pool de
// Prisma (13 conexiones) se llenaba en segundos y todo lo demas hacia timeout
// (incluidos los inserts del uptime monitor). Ahora batcheamos:
// flush cada 2s o al llegar a 100 lineas, en un solo createMany.

const BATCH_MAX = 100
const BATCH_INTERVAL_MS = 2000

const buffer: {
  ts: Date
  source: string
  level: string
  msg: string
}[] = []
let flushTimer: NodeJS.Timeout | null = null
let flushInFlight = false

async function flush(): Promise<void> {
  if (flushInFlight) return
  if (buffer.length === 0) return
  flushInFlight = true
  const batch = buffer.splice(0, BATCH_MAX)
  try {
    await prisma.logEntry.createMany({ data: batch })
  } catch (err) {
    console.error('[logsCapture] batch persist fail:', (err as Error).message)
    // No re-inyectamos las lineas: si la DB esta caida, mejor dropear que crecer
    // el buffer sin limite. En prod la DB responde bien.
  } finally {
    flushInFlight = false
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, BATCH_INTERVAL_MS)
}

function persistLine(line: CapturedLine): void {
  buffer.push({
    ts: line.ts ? new Date(line.ts) : new Date(),
    source: 'qeb-back',
    level: line.level,
    msg: line.msg.slice(0, 65000),
  })
  // Si el buffer se llena mucho, flusheamos ya sin esperar el timer.
  if (buffer.length >= BATCH_MAX) {
    void flush()
  } else {
    scheduleFlush()
  }
}

/**
 * Generator asíncrono. Cada `yield` es una línea de log ya parseada.
 * Al mismo tiempo, cada línea se guarda en la DB (fire-and-forget).
 */
export async function* streamAndCapture(
  signal: AbortSignal,
): AsyncGenerator<CapturedLine, void, undefined> {
  const liveUrl = await getDoAppLiveLogsUrl()
  if (!liveUrl) throw new Error('no se pudo obtener live_url de DO')

  const res = await fetch(liveUrl, { signal })
  if (!res.ok) throw new Error(`live_url respondió ${res.status}`)
  if (!res.body) throw new Error('respuesta sin body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // última línea puede estar incompleta

      for (const raw of lines) {
        if (!raw.trim()) continue
        const line = parseLine(raw)
        if (!line) continue
        // Solo pusheamos al buffer batcheado (sin await, sin promesas).
        persistLine(line)
        yield line
      }
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* noop */
    }
  }
}
