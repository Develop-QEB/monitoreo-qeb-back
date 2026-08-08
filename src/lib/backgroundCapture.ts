import { streamAndCapture } from './logsCapture'
import { doAppConfigured } from './doApi'

/**
 * Captura de logs 24/7 (mientras el proceso Node esté vivo).
 * En Render Free, el proceso duerme tras ~15min sin tráfico → cuando revive,
 * este módulo re-arranca la captura automáticamente.
 * Para 24/7 real, usar ping externo (uptimerobot / cron-job.org) al /health.
 */

interface CaptureStatus {
  running: boolean
  startedAt: string | null
  restartCount: number
  lastError: string | null
  lastErrorAt: string | null
}

class BackgroundCapture {
  private ac: AbortController | null = null
  private isRunning = false
  private startedAt: string | null = null
  private restartCount = 0
  private lastError: string | null = null
  private lastErrorAt: string | null = null
  private stopRequested = false

  status(): CaptureStatus {
    return {
      running: this.isRunning && !this.ac?.signal.aborted,
      startedAt: this.startedAt,
      restartCount: this.restartCount,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
    }
  }

  start(): void {
    if (this.isRunning) return
    if (!doAppConfigured()) {
      console.log('[bg-capture] DO_API_TOKEN o DO_APP_ID_QEB_BACK sin configurar, no arranca')
      return
    }
    this.stopRequested = false
    this.startedAt = new Date().toISOString()
    console.log('[bg-capture] arrancando')
    void this.runLoop()
  }

  stop(): void {
    this.stopRequested = true
    this.isRunning = false
    this.ac?.abort()
  }

  private async runLoop(): Promise<void> {
    while (!this.stopRequested) {
      this.isRunning = true
      this.ac = new AbortController()
      try {
        for await (const _line of streamAndCapture(this.ac.signal)) {
          // streamAndCapture ya persiste cada línea a monitor_logs
          void _line
        }
        // Si sale del generador sin error (stream cerrado), reintentamos
        this.lastError = 'stream cerrado por DO, reintentando'
        this.lastErrorAt = new Date().toISOString()
      } catch (err) {
        this.lastError = (err as Error).message
        this.lastErrorAt = new Date().toISOString()
        console.error('[bg-capture] error:', this.lastError)
      }
      this.isRunning = false
      if (this.stopRequested) break
      this.restartCount += 1
      // Backoff 10s antes de reintentar (no saturar DO API si algo está mal)
      await new Promise((r) => setTimeout(r, 10_000))
    }
    console.log('[bg-capture] loop terminó (stopRequested)')
  }
}

export const bgCapture = new BackgroundCapture()
