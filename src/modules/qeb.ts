import { Router, type Request, type Response } from 'express'
import type { RowDataPacket } from 'mysql2'
import { getQebPool, isQebConfigured } from '../lib/qebDb'
import { requireAuth } from '../middleware/auth'

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
    return res.json({ tickets: rows })
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

interface SessionLockRow extends RowDataPacket {
  id: number
  module_name: string
  user_id: number | null
  username: string | null
  locked_at: Date | string
}

qebRouter.get('/actividad/sesiones', async (_req: Request, res: Response) => {
  const pool = getQebPool()!
  try {
    const [rows] = await pool.query<SessionLockRow[]>(
      `SELECT id, module_name, user_id, username, locked_at
       FROM session_locks
       WHERE locked_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
       ORDER BY locked_at DESC
       LIMIT 50`,
    )
    return res.json({ sesiones: rows })
  } catch (err) {
    console.error('[/api/qeb/actividad/sesiones]', err)
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

qebRouter.get('/actividad/usuarios', async (req: Request, res: Response) => {
  const pool = getQebPool()!
  const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500)
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
