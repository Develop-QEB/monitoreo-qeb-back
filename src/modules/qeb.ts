import { Router, type Request, type Response } from 'express'
import type { RowDataPacket } from 'mysql2'
import { getQebPool, isQebConfigured } from '../lib/qebDb'
import { requireAuth } from '../middleware/auth'
import { maskDevName, maskDevById, ensureTeamAliasFresh } from '../lib/qebTeamAlias'

export const qebRouter: Router = Router()

qebRouter.use(requireAuth)

// Guard: si no está configurada la URL de prod, todos los endpoints responden 503.
qebRouter.use((_req: Request, res: Response, next) => {
  if (!isQebConfigured()) {
    return res.status(503).json({
      error: 'DATABASE_URL_QEB no configurada en el back del monitor',
    })
  }
  return next()
})

// ============================================================
// campañas
// ============================================================

interface CampaniaRow extends RowDataPacket {
  id: number
  nombre: string
  fecha_inicio: Date | string
  fecha_fin: Date | string
  total_caras: string
  status: string
  fecha_aprobacion: Date | string | null
  posted_to_sap: number | null
  cliente: string | null
  asesor: string | null
  razon_social: string | null
}

qebRouter.get('/campania', async (req: Request, res: Response) => {
  const pool = getQebPool()!
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200)
  const scope = String(req.query.scope ?? 'reciente')
  const where =
    scope === 'vigentes'
      ? 'WHERE c.fecha_inicio <= CURDATE() AND c.fecha_fin >= CURDATE()'
      : ''
  try {
    const [rows] = await pool.query<CampaniaRow[]>(
      `SELECT
         c.id, c.nombre, c.fecha_inicio, c.fecha_fin, c.total_caras,
         c.status, c.fecha_aprobacion, c.posted_to_sap,
         cl.T0_U_Cliente     AS cliente,
         cl.T0_U_Asesor      AS asesor,
         cl.T0_U_RazonSocial AS razon_social
       FROM campania c
       LEFT JOIN cliente cl ON cl.id = c.cliente_id
       ${where}
       ORDER BY c.fecha_inicio DESC
       LIMIT ?`,
      [limit],
    )
    return res.json({ campanias: rows })
  } catch (err) {
    console.error('[/api/qeb/campania]', err)
    return res.status(500).json({ error: (err as Error).message })
  }
})

interface CampaniaStatsRow extends RowDataPacket {
  total: number
  vigentes: number
  aprobadas: number
  por_iniciar: number
  proximas_a_vencer: number
  sin_arte: number
}

qebRouter.get('/campania/stats', async (_req: Request, res: Response) => {
  const pool = getQebPool()!
  try {
    const [rows] = await pool.query<CampaniaStatsRow[]>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN fecha_inicio <= CURDATE() AND fecha_fin >= CURDATE() THEN 1 ELSE 0 END) AS vigentes,
         SUM(CASE WHEN status = 'Aprobada'    THEN 1 ELSE 0 END) AS aprobadas,
         SUM(CASE WHEN status = 'Por iniciar' THEN 1 ELSE 0 END) AS por_iniciar,
         SUM(CASE WHEN fecha_fin BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS proximas_a_vencer,
         SUM(CASE WHEN fecha_aprobacion IS NULL
                    AND fecha_inicio <= CURDATE()
                    AND fecha_fin    >= CURDATE()
              THEN 1 ELSE 0 END) AS sin_arte
       FROM campania`,
    )
    return res.json({ stats: rows[0] })
  } catch (err) {
    console.error('[/api/qeb/campania/stats]', err)
    return res.status(500).json({ error: (err as Error).message })
  }
})

// ============================================================
// tickets
// ============================================================

interface TicketRow extends RowDataPacket {
  id: number
  titulo: string
  status: string
  prioridad: string
  categoria: string | null
  area: string
  usuario_nombre: string
  usuario_email: string
  respondido_por: string | null
  created_at: Date | string
  respondido_at: Date | string | null
}

qebRouter.get('/tickets', async (req: Request, res: Response) => {
  const pool = getQebPool()!
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200)
  const areaFilter = String(req.query.area ?? '')
  const statusFilter = String(req.query.status ?? '')
  const conds: string[] = []
  const params: (string | number)[] = []
  if (areaFilter && ['TI', 'QEB'].includes(areaFilter)) {
    conds.push('area = ?')
    params.push(areaFilter)
  }
  if (statusFilter) {
    conds.push('status = ?')
    params.push(statusFilter)
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : ''
  params.push(limit)
  try {
    await ensureTeamAliasFresh()
    const [rows] = await pool.query<TicketRow[]>(
      `SELECT id, titulo, status, prioridad, categoria, area,
              usuario_nombre, usuario_email, respondido_por,
              created_at, respondido_at
       FROM tickets
       ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
      params,
    )
    // Enmascarar quien responde el ticket cuando es del team DEV.
    // No enmascaramos usuario_nombre porque es el que ABRIO el ticket (cliente).
    const masked = rows.map((r) => ({
      ...r,
      respondido_por: maskDevName(r.id, r.respondido_por),
    }))
    return res.json({ tickets: masked })
  } catch (err) {
    console.error('[/api/qeb/tickets]', err)
    return res.status(500).json({ error: (err as Error).message })
  }
})

interface TicketStatsRow extends RowDataPacket {
  total: number
  nuevos: number
  en_proceso: number
  resueltos: number
  sin_respuesta: number
  area_ti: number
  area_qeb: number
  alta: number
}

qebRouter.get('/tickets/stats', async (_req: Request, res: Response) => {
  const pool = getQebPool()!
  try {
    const [rows] = await pool.query<TicketStatsRow[]>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'Nuevo'      THEN 1 ELSE 0 END) AS nuevos,
         SUM(CASE WHEN status = 'En proceso' THEN 1 ELSE 0 END) AS en_proceso,
         SUM(CASE WHEN status = 'Resuelto'   THEN 1 ELSE 0 END) AS resueltos,
         SUM(CASE WHEN status = 'Nuevo' AND respondido_at IS NULL THEN 1 ELSE 0 END) AS sin_respuesta,
         SUM(CASE WHEN area = 'TI'  THEN 1 ELSE 0 END) AS area_ti,
         SUM(CASE WHEN area = 'QEB' THEN 1 ELSE 0 END) AS area_qeb,
         SUM(CASE WHEN prioridad = 'Alta' AND status != 'Resuelto' THEN 1 ELSE 0 END) AS alta
       FROM tickets`,
    )
    return res.json({ stats: rows[0] })
  } catch (err) {
    console.error('[/api/qeb/tickets/stats]', err)
    return res.status(500).json({ error: (err as Error).message })
  }
})

interface TicketDistRow extends RowDataPacket {
  categoria: string | null
  area: string
  count: number
}

interface TicketFullRow extends RowDataPacket {
  id: number
  titulo: string
  descripcion: string
  imagen: string | null
  status: string
  prioridad: string
  categoria: string | null
  area: string
  usuario_id: number
  usuario_nombre: string
  usuario_email: string
  respuesta: string | null
  respondido_por: string | null
  respondido_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
  status_cambiado_por: string | null
}

interface TicketMessageRow extends RowDataPacket {
  id: number
  ticket_id: number
  usuario_id: number
  usuario_nombre: string
  mensaje: string | null
  archivo_url: string | null
  archivo_nombre: string | null
  archivo_tipo: string | null
  created_at: Date | string
}

// Ticket individual con detalles + mensajes + chat asociados
qebRouter.get('/tickets/:id', async (req: Request<{ id: string }>, res: Response) => {
  const pool = getQebPool()!
  const id = parseInt(req.params.id, 10)
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id invalido' })
  try {
    const [ticketRows] = await pool.query<TicketFullRow[]>(
      `SELECT id, titulo, descripcion, imagen, status, prioridad, categoria, area,
              usuario_id, usuario_nombre, usuario_email,
              respuesta, respondido_por, respondido_at,
              created_at, updated_at, status_cambiado_por
       FROM tickets
       WHERE id = ?
       LIMIT 1`,
      [id],
    )
    if (ticketRows.length === 0) return res.status(404).json({ error: 'ticket no existe' })
    await ensureTeamAliasFresh()

    const [mensajes] = await pool.query<TicketMessageRow[]>(
      `SELECT id, ticket_id, usuario_id, usuario_nombre, mensaje,
              archivo_url, archivo_nombre, archivo_tipo, created_at
       FROM ticket_mensajes
       WHERE ticket_id = ?
       ORDER BY created_at ASC`,
      [id],
    )
    const [chat] = await pool.query<TicketMessageRow[]>(
      `SELECT id, ticket_id, usuario_id, usuario_nombre, mensaje,
              archivo_url, archivo_nombre, archivo_tipo, created_at
       FROM ticket_chat
       WHERE ticket_id = ?
       ORDER BY created_at ASC`,
      [id],
    )

    // Enmascarar TODOS los campos donde aparece nombre de alguien del team DEV,
    // pero conservar usuario_nombre del ticket (quien LO ABRIO = cliente).
    const t = ticketRows[0]
    const maskedTicket = {
      ...t,
      respondido_por: maskDevName(t.id, t.respondido_por),
      status_cambiado_por: maskDevName(t.id, t.status_cambiado_por),
    }
    const maskedMensajes = mensajes.map((m) => ({
      ...m,
      usuario_nombre: maskDevById(m.ticket_id, m.usuario_id, m.usuario_nombre),
    }))
    const maskedChat = chat.map((m) => ({
      ...m,
      usuario_nombre: maskDevById(m.ticket_id, m.usuario_id, m.usuario_nombre),
    }))

    return res.json({
      ticket: maskedTicket,
      mensajes: maskedMensajes,
      chat: maskedChat,
    })
  } catch (err) {
    console.error('[/api/qeb/tickets/:id]', err)
    return res.status(500).json({ error: (err as Error).message })
  }
})

qebRouter.get('/tickets/by-categoria', async (_req: Request, res: Response) => {
  const pool = getQebPool()!
  try {
    const [rows] = await pool.query<TicketDistRow[]>(
      `SELECT categoria, area, COUNT(*) AS count
       FROM tickets
       GROUP BY categoria, area
       ORDER BY count DESC`,
    )
    return res.json({ distribucion: rows })
  } catch (err) {
    console.error('[/api/qeb/tickets/by-categoria]', err)
    return res.status(500).json({ error: (err as Error).message })
  }
})

// ============================================================
// reservas
// ============================================================

interface ReservasStatsRow extends RowDataPacket {
  total: number
  activas: number
  eliminadas: number
  sin_archivo: number
  con_aps: number
  sin_aps: number
  instaladas: number
}

qebRouter.get('/reservas/stats', async (_req: Request, res: Response) => {
  const pool = getQebPool()!
  try {
    const [rows] = await pool.query<ReservasStatsRow[]>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS activas,
         SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS eliminadas,
         SUM(CASE WHEN deleted_at IS NULL AND (archivo IS NULL OR archivo = '') THEN 1 ELSE 0 END) AS sin_archivo,
         SUM(CASE WHEN deleted_at IS NULL AND APS IS NOT NULL THEN 1 ELSE 0 END) AS con_aps,
         SUM(CASE WHEN deleted_at IS NULL AND APS IS NULL     THEN 1 ELSE 0 END) AS sin_aps,
         SUM(CASE WHEN deleted_at IS NULL AND instalado = 1   THEN 1 ELSE 0 END) AS instaladas
       FROM reservas`,
    )
    return res.json({ stats: rows[0] })
  } catch (err) {
    console.error('[/api/qeb/reservas/stats]', err)
    return res.status(500).json({ error: (err as Error).message })
  }
})

interface ReservasByEstatusRow extends RowDataPacket {
  estatus: string
  count: number
}

qebRouter.get('/reservas/by-estatus', async (_req: Request, res: Response) => {
  const pool = getQebPool()!
  try {
    const [rows] = await pool.query<ReservasByEstatusRow[]>(
      `SELECT estatus, COUNT(*) AS count
       FROM reservas
       WHERE deleted_at IS NULL
       GROUP BY estatus
       ORDER BY count DESC
       LIMIT 15`,
    )
    return res.json({ distribucion: rows })
  } catch (err) {
    console.error('[/api/qeb/reservas/by-estatus]', err)
    return res.status(500).json({ error: (err as Error).message })
  }
})

// ============================================================
// actividad · usuarios y sesiones activas
// ============================================================

interface UsuarioStatsRow extends RowDataPacket {
  total: number
  activos: number
  deleted: number
  area_admin: number
  area_ventas: number
  area_ti: number
  area_diseno: number
  area_otro: number
}

qebRouter.get('/actividad/stats', async (_req: Request, res: Response) => {
  const pool = getQebPool()!
  try {
    const [rows] = await pool.query<UsuarioStatsRow[]>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS activos,
         SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted,
         SUM(CASE WHEN deleted_at IS NULL AND (area LIKE '%dmin%' OR area = 'Administración') THEN 1 ELSE 0 END) AS area_admin,
         SUM(CASE WHEN deleted_at IS NULL AND (area LIKE '%enta%' OR puesto LIKE '%esor%') THEN 1 ELSE 0 END) AS area_ventas,
         SUM(CASE WHEN deleted_at IS NULL AND area LIKE '%TI%' THEN 1 ELSE 0 END) AS area_ti,
         SUM(CASE WHEN deleted_at IS NULL AND area LIKE '%iseño%' THEN 1 ELSE 0 END) AS area_diseno,
         SUM(CASE WHEN deleted_at IS NULL AND area IS NULL THEN 1 ELSE 0 END) AS area_otro
       FROM usuario`,
    )
    return res.json({ stats: rows[0] })
  } catch (err) {
    console.error('[/api/qeb/actividad/stats]', err)
    return res.status(500).json({ error: (err as Error).message })
  }
})

interface UsuarioRow extends RowDataPacket {
  id: number
  nombre: string
  correo_electronico: string
  area: string
  puesto: string
  user_role: string
  created_at: Date | string | null
  updated_at: Date | string | null
}

// ============================================================
// stats MySQL (SHOW STATUS + tablas)
// ============================================================

interface StatusRow extends RowDataPacket {
  Variable_name: string
  Value: string
}

qebRouter.get('/db/status', async (_req: Request, res: Response) => {
  const pool = getQebPool()!
  try {
    const [statusRows] = await pool.query<StatusRow[]>(
      `SHOW GLOBAL STATUS WHERE Variable_name IN (
        'Uptime',
        'Threads_connected',
        'Threads_running',
        'Max_used_connections',
        'Questions',
        'Slow_queries',
        'Aborted_connects',
        'Innodb_buffer_pool_pages_total',
        'Innodb_buffer_pool_pages_free',
        'Innodb_buffer_pool_pages_dirty',
        'Innodb_row_lock_time_avg',
        'Innodb_row_lock_waits',
        'Bytes_sent',
        'Bytes_received',
        'Com_select',
        'Com_insert',
        'Com_update',
        'Com_delete'
      )`,
    )
    const [varsRows] = await pool.query<StatusRow[]>(
      `SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections', 'version', 'innodb_buffer_pool_size')`,
    )

    const status: Record<string, string> = {}
    statusRows.forEach((r) => (status[r.Variable_name] = r.Value))
    const vars: Record<string, string> = {}
    varsRows.forEach((r) => (vars[r.Variable_name] = r.Value))

    const uptime = parseInt(status.Uptime ?? '0', 10)
    const questions = parseInt(status.Questions ?? '0', 10)
    const bufferTotal = parseInt(status.Innodb_buffer_pool_pages_total ?? '0', 10)
    const bufferFree = parseInt(status.Innodb_buffer_pool_pages_free ?? '0', 10)
    const bufferUsedPct = bufferTotal > 0 ? ((bufferTotal - bufferFree) / bufferTotal) * 100 : 0

    return res.json({
      uptime_sec: uptime,
      version: vars.version ?? 'unknown',
      max_connections: parseInt(vars.max_connections ?? '0', 10),
      threads_connected: parseInt(status.Threads_connected ?? '0', 10),
      threads_running: parseInt(status.Threads_running ?? '0', 10),
      max_used_connections: parseInt(status.Max_used_connections ?? '0', 10),
      queries_total: questions,
      queries_per_sec_avg: uptime > 0 ? Number((questions / uptime).toFixed(2)) : 0,
      slow_queries: parseInt(status.Slow_queries ?? '0', 10),
      aborted_connects: parseInt(status.Aborted_connects ?? '0', 10),
      buffer_pool_used_pct: Number(bufferUsedPct.toFixed(1)),
      innodb_buffer_pool_size_mb:
        Math.round(parseInt(vars.innodb_buffer_pool_size ?? '0', 10) / (1024 * 1024)),
      innodb_row_lock_waits: parseInt(status.Innodb_row_lock_waits ?? '0', 10),
      innodb_row_lock_time_avg_ms: parseInt(status.Innodb_row_lock_time_avg ?? '0', 10),
      bytes_sent_gb: Number((parseInt(status.Bytes_sent ?? '0', 10) / 1024 / 1024 / 1024).toFixed(2)),
      bytes_received_gb: Number((parseInt(status.Bytes_received ?? '0', 10) / 1024 / 1024 / 1024).toFixed(2)),
      commands: {
        select: parseInt(status.Com_select ?? '0', 10),
        insert: parseInt(status.Com_insert ?? '0', 10),
        update: parseInt(status.Com_update ?? '0', 10),
        delete: parseInt(status.Com_delete ?? '0', 10),
      },
    })
  } catch (err) {
    console.error('[/api/qeb/db/status]', err)
    return res.status(500).json({ error: (err as Error).message })
  }
})

interface TableSizeRow extends RowDataPacket {
  table_name: string
  table_rows: number | null
  data_length: number | null
  index_length: number | null
  total_size: number | null
}

qebRouter.get('/db/tables', async (_req: Request, res: Response) => {
  const pool = getQebPool()!
  try {
    const [rows] = await pool.query<TableSizeRow[]>(
      `SELECT
         TABLE_NAME       AS table_name,
         TABLE_ROWS       AS table_rows,
         DATA_LENGTH      AS data_length,
         INDEX_LENGTH     AS index_length,
         (DATA_LENGTH + INDEX_LENGTH) AS total_size
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
       ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC
       LIMIT 15`,
    )
    return res.json({
      tables: rows.map((r) => ({
        table: r.table_name,
        rows: r.table_rows ?? 0,
        data_mb: Number(((r.data_length ?? 0) / 1024 / 1024).toFixed(1)),
        index_mb: Number(((r.index_length ?? 0) / 1024 / 1024).toFixed(1)),
        total_mb: Number(((r.total_size ?? 0) / 1024 / 1024).toFixed(1)),
      })),
    })
  } catch (err) {
    console.error('[/api/qeb/db/tables]', err)
    return res.status(500).json({ error: (err as Error).message })
  }
})

// ============================================================
// índices críticos (verificación estática)
// ============================================================

interface IndexRow extends RowDataPacket {
  TABLE_NAME: string
  INDEX_NAME: string
}

// Los 7 índices que fase de rendimiento del dashboard necesita.
// Ver back-qeb/scripts/add_idx_dashboard_perf.cjs
const CRITICAL_INDEXES: { table: string; name: string }[] = [
  { table: 'inventarios', name: 'idx_inv_estado' },
  { table: 'inventarios', name: 'idx_inv_plaza' },
  { table: 'inventarios', name: 'idx_inv_mueble' },
  { table: 'inventarios', name: 'idx_inv_nse' },
  { table: 'inventarios', name: 'idx_inv_tipo' },
  { table: 'inventarios', name: 'idx_inv_estatus' },
  { table: 'reservas',    name: 'idx_rsv_calendario' },
]

qebRouter.get('/indices', async (_req: Request, res: Response) => {
  const pool = getQebPool()!
  try {
    const [rows] = await pool.query<IndexRow[]>(
      `SELECT DISTINCT TABLE_NAME, INDEX_NAME
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME IN ('inventarios', 'reservas')
         AND (INDEX_NAME LIKE 'idx_inv_%' OR INDEX_NAME = 'idx_rsv_calendario')`,
    )
    const foundSet = new Set(rows.map((r) => `${r.TABLE_NAME}::${r.INDEX_NAME}`))
    const indexes = CRITICAL_INDEXES.map((idx) => ({
      table: idx.table,
      name: idx.name,
      present: foundSet.has(`${idx.table}::${idx.name}`),
    }))
    const allPresent = indexes.every((i) => i.present)
    return res.json({
      expected: CRITICAL_INDEXES.length,
      found: indexes.filter((i) => i.present).length,
      allPresent,
      indexes,
    })
  } catch (err) {
    console.error('[/api/qeb/indices]', err)
    return res.status(500).json({ error: (err as Error).message })
  }
})

qebRouter.get('/actividad/usuarios', async (req: Request, res: Response) => {
  const pool = getQebPool()!
  // Default 500 (arriba de los ~109 activos actuales) para que el listado no
  // se corte y coincida con la KPI "activos" del /actividad/stats.
  const limit = Math.min(parseInt(String(req.query.limit ?? '500'), 10) || 500, 500)
  try {
    const [rows] = await pool.query<UsuarioRow[]>(
      `SELECT id, nombre, correo_electronico, area, puesto, user_role,
              created_at, updated_at
       FROM usuario
       WHERE deleted_at IS NULL
       ORDER BY nombre ASC
       LIMIT ?`,
      [limit],
    )
    return res.json({ usuarios: rows })
  } catch (err) {
    console.error('[/api/qeb/actividad/usuarios]', err)
    return res.status(500).json({ error: (err as Error).message })
  }
})

// ============================================================
// Slow queries via performance_schema
// ============================================================
// events_statements_summary_by_digest agrupa queries por "digest" (SQL
// normalizado). Sin habilitar slow_log. Fuente clave para prevenir incidentes
// como el CPU 100% que ya tuvieron.

interface SlowQueryRow extends RowDataPacket {
  digest: string
  digest_text: string
  count_star: number
  avg_ms: number
  max_ms: number
  sum_ms: number
  rows_examined_avg: number
  rows_sent_avg: number
  last_seen: Date | string | null
  first_seen: Date | string | null
}

qebRouter.get('/slow-queries', async (req: Request, res: Response) => {
  const pool = getQebPool()!
  const limit = Math.max(5, Math.min(100, parseInt(String(req.query.limit ?? '20'), 10) || 20))
  const minAvgMs = Math.max(0, parseInt(String(req.query.minAvgMs ?? '0'), 10) || 0)
  const orderBy = String(req.query.orderBy ?? 'sum') // 'sum' | 'avg' | 'count' | 'max'
  const orderCol =
    orderBy === 'avg'
      ? 'avg_ms'
      : orderBy === 'count'
        ? 'count_star'
        : orderBy === 'max'
          ? 'max_ms'
          : 'sum_ms'
  try {
    const [rows] = await pool.query<SlowQueryRow[]>(
      `SELECT
         DIGEST as digest,
         DIGEST_TEXT as digest_text,
         COUNT_STAR as count_star,
         ROUND(AVG_TIMER_WAIT / 1000000000, 2) as avg_ms,
         ROUND(MAX_TIMER_WAIT / 1000000000, 2) as max_ms,
         ROUND(SUM_TIMER_WAIT / 1000000000, 2) as sum_ms,
         ROUND(SUM_ROWS_EXAMINED / GREATEST(COUNT_STAR, 1), 0) as rows_examined_avg,
         ROUND(SUM_ROWS_SENT / GREATEST(COUNT_STAR, 1), 0) as rows_sent_avg,
         LAST_SEEN as last_seen,
         FIRST_SEEN as first_seen
       FROM performance_schema.events_statements_summary_by_digest
       WHERE SCHEMA_NAME = DATABASE()
         AND (AVG_TIMER_WAIT / 1000000000) >= ?
       ORDER BY ${orderCol} DESC
       LIMIT ?`,
      [minAvgMs, limit],
    )
    return res.json({ orderBy, minAvgMs, queries: rows })
  } catch (err) {
    // Mensaje amigable si monitor_readonly no tiene grant a performance_schema.
    const msg = (err as Error).message
    if (msg.includes('SELECT command denied') || msg.includes("Access denied")) {
      return res.status(403).json({
        error:
          'monitor_readonly no tiene permiso a performance_schema. Ejecutar: GRANT SELECT ON performance_schema.* TO monitor_readonly',
      })
    }
    console.error('[/api/qeb/slow-queries]', err)
    return res.status(500).json({ error: msg })
  }
})
