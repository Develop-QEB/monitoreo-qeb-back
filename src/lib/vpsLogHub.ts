import { EventEmitter } from 'node:events'

/**
 * Hub en memoria para los logs del VPS (tab "vps", modo SOLO-EN-VIVO).
 *
 * El agente de PowerShell del VPS hace POST a /api/vps/logs/ingest y cada línea
 * cae aquí. Los clientes SSE (/api/vps/logs/live) se suscriben al evento 'line'
 * y reciben cada línea conforme llega. Guardamos además un ring buffer chico
 * para que un navegador que se acaba de conectar vea las últimas N líneas de
 * contexto de inmediato.
 *
 * No hay DB: si el proceso del back se reinicia, el buffer se pierde. Es lo
 * esperado en modo solo-en-vivo.
 */

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'

export interface VpsLogLine {
  ts: string // ISO
  msg: string
  level: LogLevel
  source: string // hostname del VPS (COMPUTERNAME)
}

export function detectLevel(msg: string): LogLevel {
  const u = msg.toUpperCase()
  if (
    u.includes('ERROR') ||
    u.includes('EXCEPTION') ||
    u.includes('FATAL') ||
    u.includes('ECONNREFUSED')
  )
    return 'ERROR'
  if (u.includes('WARN')) return 'WARN'
  if (u.includes('DEBUG') || u.includes('VERBOSE')) return 'DEBUG'
  return 'INFO'
}

const RING_SIZE = 500

class VpsLogHub extends EventEmitter {
  private ring: VpsLogLine[] = []
  private _lastLineAt: number | null = null

  push(line: VpsLogLine): void {
    this.ring.push(line)
    if (this.ring.length > RING_SIZE) this.ring.shift()
    this._lastLineAt = Date.now()
    this.emit('line', line)
  }

  recent(): VpsLogLine[] {
    return this.ring.slice()
  }

  get lastLineAt(): number | null {
    return this._lastLineAt
  }

  get buffered(): number {
    return this.ring.length
  }
}

// Singleton — vive mientras el proceso viva.
export const vpsLogHub = new VpsLogHub()
// Cada cliente SSE es un listener; quitamos el límite de 10 por defecto.
vpsLogHub.setMaxListeners(0)
