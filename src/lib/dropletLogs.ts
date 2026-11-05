import { EventEmitter } from 'node:events'
import { spawn, execFile } from 'node:child_process'
import { detectLevel, type VpsLogLine } from './vpsLogHub'

/**
 * Logs del DROPLET (Ubuntu) leidos EN EL MISMO HOST donde corre este back.
 *
 * A diferencia del tab VPS viejo (Windows empujaba por HTTP con secreto), aqui
 * el monitoreo-back vive en el droplet, asi que leemos directo los archivos de
 * pm2 (`<name>-out.log` / `<name>-error.log`) con `tail -F` y sacamos el estado
 * real de cada proceso con `pm2 jlist`. Cada linea se etiqueta con su `source`
 * (autosync | qeb-api) para que el front pinte dos consolas separadas.
 *
 * Solo-en-vivo + ring buffer (no DB). Si el back se reinicia, el buffer se
 * pierde (igual que el hub del VPS).
 */

export interface DropletSource {
  key: string // identificador estable que viaja en cada linea
  label: string // etiqueta para el front
  pm2: string // nombre del proceso en pm2 (= nombre del archivo de log)
}

// "qeb-api" = el proxy SAP (qeb-sap-proxy, sap.qeb.mx): el que saca articulos/CUIC
// de SAP. (El back principal de release es otro proceso; se puede agregar aparte.)
export const DROPLET_SOURCES: DropletSource[] = [
  { key: 'autosync', label: 'autosync', pm2: 'qeb-sync' },
  { key: 'qeb-api', label: 'qeb-api', pm2: 'qeb-sap-proxy' },
]

const PM2_LOG_DIR = process.env.PM2_LOG_DIR || '/root/.pm2/logs'
const PM2_BIN = process.env.PM2_BIN || '/usr/bin/pm2'
// Ring POR FUENTE: el proxy es muy hablador y, con un ring unico compartido,
// desalojaba las lineas del autosync (que solo loguea cada ~30 min) dejando su
// consola vacia. Con un ring por fuente cada consola conserva su propia historia.
const RING_PER_SOURCE = 400
const BACKFILL_LINES = 120

// pm2 antepone un timestamp UTC a cada linea: "2026-11-05T16:17:53: <msg>".
// Lo parseamos para usar la hora REAL del evento (no la de lectura) y para que el
// backfill no haga parecer "de ahora" lineas viejas. Sin prefijo -> hora de lectura.
const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:[.,]\d+)?:\s?([\s\S]*)$/
function parseLogLine(raw: string): { ts: string; msg: string } {
  const m = TS_RE.exec(raw)
  if (m) {
    const d = new Date(m[1] + 'Z') // el prefijo de pm2 esta en UTC
    if (!Number.isNaN(d.getTime())) return { ts: d.toISOString(), msg: m[2] }
  }
  return { ts: new Date().toISOString(), msg: raw }
}

class DropletLogHub extends EventEmitter {
  private rings = new Map<string, VpsLogLine[]>()
  private _lastLineAt: number | null = null

  push(line: VpsLogLine): void {
    const r = this.rings.get(line.source) ?? []
    r.push(line)
    if (r.length > RING_PER_SOURCE) r.shift()
    this.rings.set(line.source, r)
    this._lastLineAt = Date.now()
    this.emit('line', line)
  }

  // Todas las fuentes mezcladas y ordenadas por tiempo (para el replay al conectar).
  recent(): VpsLogLine[] {
    const all: VpsLogLine[] = []
    for (const r of this.rings.values()) all.push(...r)
    all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    return all
  }

  get lastLineAt(): number | null {
    return this._lastLineAt
  }
}

export const dropletLogHub = new DropletLogHub()
dropletLogHub.setMaxListeners(0)

let started = false

/** Arranca un `tail -F` por fuente (idempotente). Seguro en entornos sin pm2/tail. */
export function startDropletTailers(): void {
  if (started) return
  started = true
  for (const s of DROPLET_SOURCES) {
    // El -out SI trae backfill (contexto reciente, para que la consola no salga
    // vacia al abrir; clave para el autosync que solo loguea cada ~30 min).
    // El -error NO (backfill 0): un proceso que erro y se recupero deja su
    // *-error.log quieto con esos errores como ultima cola, y re-volcarlos en
    // cada restart los hacia parecer "de ahora" (los del proxy ni siquiera
    // traen timestamp de pm2 para fecharlos bien). Asi solo llegan errores NUEVOS.
    spawnTail(s, `${PM2_LOG_DIR}/${s.pm2}-out.log`, BACKFILL_LINES)
    spawnTail(s, `${PM2_LOG_DIR}/${s.pm2}-error.log`, 0)
  }
}

function spawnTail(s: DropletSource, file: string, backfill: number): void {
  let child
  try {
    // -F sigue el archivo aunque aun no exista o rote.
    child = spawn('tail', ['-n', String(backfill), '-F', file], { stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return // sin `tail` (p.ej. dev en Windows): simplemente no hay logs de droplet
  }
  let buf = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    const parts = buf.split('\n')
    buf = parts.pop() ?? ''
    for (const raw of parts) {
      const msg = raw.replace(/\s+$/, '')
      if (!msg) continue
      if (msg.startsWith('==> ') && msg.endsWith(' <==')) continue // headers de tail -F
      const { ts, msg: clean } = parseLogLine(msg)
      dropletLogHub.push({
        ts,
        msg: clean.slice(0, 65000),
        level: detectLevel(clean),
        source: s.key,
      })
    }
  })
  child.on('error', () => {
    /* tail no disponible: no hacemos nada */
  })
  child.on('exit', () => {
    // Si tail muere (rotacion rara, etc.), lo relanzamos SIN backfill (0) para
    // no re-volcar lineas viejas en cada relanzamiento.
    setTimeout(() => spawnTail(s, file, 0), 2000)
  })
}

export interface DropletProcStatus {
  key: string
  label: string
  pm2: string
  status: string // online | stopped | errored | missing | ...
  up: boolean
  uptimeMs: number | null
  restarts: number | null
  cpu: number | null
  memory: number | null // bytes
}

interface Pm2ListItem {
  name?: string
  pm2_env?: { status?: string; pm_uptime?: number; restart_time?: number }
  monit?: { cpu?: number; memory?: number }
}

/** Estado real de cada proceso via `pm2 jlist`. Nunca rechaza; si falla -> missing. */
export function getDropletStatus(): Promise<DropletProcStatus[]> {
  return new Promise((resolve) => {
    execFile(PM2_BIN, ['jlist'], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      let list: Pm2ListItem[] = []
      if (!err && stdout) {
        try {
          list = JSON.parse(stdout) as Pm2ListItem[]
        } catch {
          list = []
        }
      }
      const byName = new Map<string, Pm2ListItem>()
      for (const p of list) if (p.name) byName.set(p.name, p)
      const out: DropletProcStatus[] = DROPLET_SOURCES.map((s) => {
        const p = byName.get(s.pm2)
        const status = p?.pm2_env?.status ?? 'missing'
        return {
          key: s.key,
          label: s.label,
          pm2: s.pm2,
          status,
          up: status === 'online',
          uptimeMs: p?.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : null,
          restarts: p?.pm2_env?.restart_time ?? null,
          cpu: p?.monit?.cpu ?? null,
          memory: p?.monit?.memory ?? null,
        }
      })
      resolve(out)
    })
  })
}
