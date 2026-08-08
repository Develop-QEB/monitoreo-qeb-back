import mysql from 'mysql2/promise'
import type { Pool } from 'mysql2/promise'
import { env } from '../config/env'

/**
 * Pool de conexión SOLO LECTURA hacia la DB de QEB producción.
 * El usuario `monitor_readonly` tiene GRANT SELECT únicamente; cualquier
 * INSERT/UPDATE/DELETE/CREATE es rechazado a nivel de MySQL.
 *
 * Se marca como Readonly para que sea IMPOSIBLE por accidente
 * llamar métodos de escritura desde TypeScript.
 */
export type ReadOnlyPool = Pick<Pool, 'query' | 'execute' | 'getConnection' | 'end'>

let pool: Pool | null = null

export function getQebPool(): ReadOnlyPool | null {
  if (!env.DATABASE_URL_QEB) return null
  if (pool) return pool
  pool = mysql.createPool({
    uri: env.DATABASE_URL_QEB,
    ssl: { rejectUnauthorized: false },
    connectionLimit: 5,
    waitForConnections: true,
    queueLimit: 20,
  })
  return pool
}

export function isQebConfigured(): boolean {
  return !!env.DATABASE_URL_QEB
}
