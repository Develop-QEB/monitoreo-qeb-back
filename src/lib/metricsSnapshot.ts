import { prisma } from './prisma'
import { getDoAppMetrics, doAppConfigured } from './doApi'

// Cada 5 minutos tomamos el "latest" de CPU y RAM del app en DO y lo persistimos.
// DO monitoring solo retiene 1h, con esta tabla tenemos 30 dias.
// Retencion: rolling delete de filas > 30 dias al insertar (barato porque las
// filas viejas se identifican por indice (metric, ts)).

const SNAPSHOT_INTERVAL_MS = 5 * 60_000
const RETENTION_DAYS = 30

async function snapshotMetric(metric: 'cpu' | 'ram'): Promise<void> {
  const apiName = metric === 'cpu' ? 'cpu_percentage' : 'memory_percentage'
  try {
    const series = await getDoAppMetrics(apiName)
    // getDoAppMetrics devuelve array de series por componente; tomamos el latest agregado.
    const latest = series?.[0]?.latest
    if (latest == null || !Number.isFinite(latest)) return
    await prisma.metricSnapshot.create({
      data: { metric, valuePct: latest },
    })
  } catch {
    // No relanzamos: no queremos matar el loop por un fallo puntual de DO API.
  }
}

async function purgeOld(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60_000)
  try {
    await prisma.metricSnapshot.deleteMany({ where: { ts: { lt: cutoff } } })
  } catch {
    // idem
  }
}

async function runRound(): Promise<void> {
  await Promise.all([snapshotMetric('cpu'), snapshotMetric('ram')])
  // Purge cada round es barato (deleteMany por indice); no vale la pena diferir.
  await purgeOld()
}

let started = false
let timer: NodeJS.Timeout | null = null

export function startMetricsSnapshot(): void {
  if (started) return
  if (!doAppConfigured()) {
    console.log('[metrics-snapshot] DO_API_TOKEN o DO_APP_ID_QEB_BACK sin configurar, no arranca')
    return
  }
  started = true
  console.log('[metrics-snapshot] arrancando (cada 5min, retencion 30d)')
  // Kick inmediato para tener al menos 1 dato al boot.
  void runRound()
  timer = setInterval(() => void runRound(), SNAPSHOT_INTERVAL_MS)
}

export function stopMetricsSnapshot(): void {
  if (timer) clearInterval(timer)
  timer = null
  started = false
}
