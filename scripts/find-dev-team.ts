// Busca los usuarios de Jos, Mario y Akary en la BD QEB para saber
// exactamente qué nombres/emails están en las tablas (para el alias mask).
import * as dotenv from 'dotenv'
import mysql from 'mysql2/promise'
dotenv.config()

async function main() {
  const url = process.env.DATABASE_URL_QEB!
  const conn = await mysql.createConnection(
    url + (url.includes('?') ? '&' : '?') + 'ssl={"rejectUnauthorized":false}',
  )

  const [rows] = await conn.query<any[]>(
    `SELECT id, nombre, correo_electronico, area, puesto, user_role
     FROM usuario
     WHERE deleted_at IS NULL
       AND (LOWER(nombre) LIKE '%jos%'
         OR LOWER(nombre) LIKE '%mario%'
         OR LOWER(nombre) LIKE '%akary%'
         OR LOWER(correo_electronico) LIKE '%jos%'
         OR LOWER(correo_electronico) LIKE '%mario%'
         OR LOWER(correo_electronico) LIKE '%develop%'
         OR LOWER(correo_electronico) LIKE '%akary%')
     ORDER BY nombre`,
  )
  console.log(`Match: ${rows.length} usuarios`)
  for (const r of rows) {
    console.log(
      `  id=${r.id} · "${r.nombre}" · ${r.correo_electronico} · ${r.area ?? '-'} · ${r.puesto ?? '-'} · ${r.user_role}`,
    )
  }

  // También revisar en tickets (columna respondido_por es un string libre)
  console.log('\n== respondido_por únicos en tickets (últimos 200) ==')
  const [tickets] = await conn.query<any[]>(
    `SELECT DISTINCT respondido_por FROM tickets
     WHERE respondido_por IS NOT NULL AND respondido_por != ''
     ORDER BY respondido_por LIMIT 200`,
  )
  for (const t of tickets) console.log(`  "${t.respondido_por}"`)

  await conn.end()
}
main().catch((e) => { console.error(e); process.exit(1) })
