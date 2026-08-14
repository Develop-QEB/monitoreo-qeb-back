// Busca formas de saber que usuarios de QEB estan activos
// (login reciente, ultima accion, etc). Corre: npx ts-node scripts/check-user-activity.ts
import * as dotenv from 'dotenv'
import mysql from 'mysql2/promise'

dotenv.config()

async function main() {
  const url = process.env.DATABASE_URL_QEB
  if (!url) throw new Error('DATABASE_URL_QEB no seteado')
  const withSsl = url + (url.includes('?') ? '&' : '?') + 'ssl={"rejectUnauthorized":false}'
  const conn = await mysql.createConnection(withSsl)

  // 1. Columnas de la tabla usuario
  console.log('== columnas de tabla usuario ==')
  const [cols] = await conn.query<any[]>(
    `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuario'
     ORDER BY ORDINAL_POSITION`,
  )
  for (const c of cols) console.log(`  ${c.COLUMN_NAME} (${c.DATA_TYPE})`)

  // 2. updated_at reciente en usuario
  console.log('\n== usuarios con updated_at reciente ==')
  const [recentUpd] = await conn.query<any[]>(
    `SELECT id, nombre, updated_at, TIMESTAMPDIFF(MINUTE, updated_at, NOW()) as min_ago
     FROM usuario
     WHERE updated_at IS NOT NULL
     ORDER BY updated_at DESC LIMIT 10`,
  )
  for (const u of recentUpd) {
    console.log(`  ${u.updated_at} · ${String(u.min_ago).padStart(5)}m atrás · ${u.nombre}`)
  }

  // 3. Buscar tablas que tengan created_at o updated_at con user_id
  console.log('\n== tablas con user_id o usuario_id ==')
  const [tablesWithUser] = await conn.query<any[]>(
    `SELECT DISTINCT TABLE_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND COLUMN_NAME IN ('user_id', 'usuario_id', 'created_by', 'updated_by')
     ORDER BY TABLE_NAME`,
  )
  for (const t of tablesWithUser) console.log(`  ${t.TABLE_NAME}`)

  // 4. Buscar tablas con "log" o "audit" en el nombre
  console.log('\n== tablas de log/audit/session ==')
  const [logTables] = await conn.query<any[]>(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND (TABLE_NAME LIKE '%log%' OR TABLE_NAME LIKE '%audit%'
         OR TABLE_NAME LIKE '%session%' OR TABLE_NAME LIKE '%login%')`,
  )
  for (const t of logTables) console.log(`  ${t.TABLE_NAME}`)

  await conn.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
