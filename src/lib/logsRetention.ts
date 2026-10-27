import { prisma } from './prisma'

// Retencion rotativa de monitor_logs: siempre los ultimos 15 dias.
// Cada hora borra lo que tenga ts > 15 dias. Se borra en lotes con LIMIT para
// no bloquear la tabla ni saturar Hostinger (un DELETE gigante tumba la BD).

const RETENTION_DAYS = 15
const PURGE_INTERVAL_MS = 60 * 60_000
const BATCH = 10_000

async function purgeOld(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60_000)
  let total = 0
  try {
    for (;;) {
      const n = await prisma.$executeRaw`DELETE FROM monitor_logs WHERE ts < ${cutoff} LIMIT ${BATCH}`
      total += n
      if (n < BATCH) break
      // Pausa corta entre lotes para dejar respirar a la BD.
      await new Promise((r) => setTimeout(r, 500))
    }
    if (total > 0) console.log(`[logs-retention] borrados ${total} logs anteriores a ${cutoff.toISOString()}`)
  } catch (err) {
    // No relanzamos: se reintenta en la siguiente ronda.
    console.error('[logs-retention] purge fail:', (err as Error).message)
  }
}

let timer: NodeJS.Timeout | null = null

export function startLogsRetention(): void {
  if (timer) return
  console.log(`[logs-retention] arrancando (cada 1h, retencion ${RETENTION_DAYS}d)`)
  void purgeOld()
  timer = setInterval(() => void purgeOld(), PURGE_INTERVAL_MS)
}

export function stopLogsRetention(): void {
  if (timer) clearInterval(timer)
  timer = null
}
