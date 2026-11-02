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

// "qeb-api" = el back principal de QEB en el droplet (release, api-release.qeb.mx).
export const DROPLET_SOURCES: DropletSource[] = [
  { key: 'autosync', label: 'autosync', pm2: 'qeb-sync' },
  { key: 'qeb-api', label: 'qeb-api', pm2: 'qeb-back-release' },
]

const PM2_LOG_DIR = process.env.PM2_LOG_DIR || '/root/.pm2/logs'
const PM2_BIN = process.env.PM2_BIN || '/usr/bin/pm2'
const RING_SIZE = 600

class DropletLogHub extends EventEmitter {
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
}

export const dropletLogHub = new DropletLogHub()
dropletLogHub.setMaxListeners(0)

let started = false

/** Arranca un `tail -F` por fuente (idempotente). Seguro en entornos sin pm2/tail. */
export function startDropletTailers(): void {
  if (started) return
  started = true
  for (const s of DROPLET_SOURCES) {
    const files = [`${PM2_LOG_DIR}/${s.pm2}-out.log`, `${PM2_LOG_DIR}/${s.pm2}-error.log`]
    spawnTail(s, files)
  }
}

function spawnTail(s: DropletSource, files: string[]): void {
  let child
  try {
    // -F sigue el archivo aunque aun no exista o rote; -n 60 da contexto inicial.
    child = spawn('tail', ['-n', '60', '-F', ...files], { stdio: ['ignore', 'pipe', 'ignore'] })
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
      dropletLogHub.push({
        ts: new Date().toISOString(),
        msg: msg.slice(0, 65000),
        level: detectLevel(msg),
        source: s.key,
      })
    }
  })
  child.on('error', () => {
    /* tail no disponible: no hacemos nada */
  })
  child.on('exit', () => {
    // Si tail muere (rotacion rara, etc.), lo relanzamos.
    setTimeout(() => spawnTail(s, files), 2000)
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
