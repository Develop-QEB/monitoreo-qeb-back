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

async function persistLine(line: CapturedLine): Promise<void> {
  try {
    await prisma.logEntry.create({
      data: {
        ts: line.ts ? new Date(line.ts) : new Date(),
        source: 'qeb-back',
        level: line.level,
        msg: line.msg.slice(0, 65000),
      },
    })
  } catch (err) {
    // best-effort: si falla la escritura, no rompemos el stream
    console.error('[logsCapture] persist fail:', (err as Error).message)
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
        // fire-and-forget insert (no bloquea el stream)
        void persistLine(line)
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
