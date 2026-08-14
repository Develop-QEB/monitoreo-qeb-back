import * as dotenv from 'dotenv'
import mysql from 'mysql2/promise'
dotenv.config()

async function main() {
  const url = process.env.DATABASE_URL_QEB!
  const withSsl = url + (url.includes('?') ? '&' : '?') + 'ssl={"rejectUnauthorized":false}'
  const conn = await mysql.createConnection(withSsl)

  const [nulls] = await conn.query<any[]>(
    `SELECT COUNT(*) as total, COUNT(usuario_id) as with_user, COUNT(*) - COUNT(usuario_id) as null_user
     FROM historial WHERE fecha_hora >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
  )
  console.log('Ultimas 24h historial:', nulls[0])

  const [byType] = await conn.query<any[]>(
    `SELECT tipo, COUNT(*) as n, COUNT(usuario_id) as with_user
     FROM historial WHERE fecha_hora >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
     GROUP BY tipo ORDER BY n DESC`,
  )
  console.log('\nPor tipo (24h):')
  for (const r of byType) console.log(`  ${r.tipo}: ${r.n} total, ${r.with_user} con user`)

  const [withUser] = await conn.query<any[]>(
    `SELECT h.id, h.tipo, h.usuario_id, u.nombre, h.fecha_hora, h.accion
     FROM historial h
     LEFT JOIN usuario u ON u.id = h.usuario_id
     WHERE h.fecha_hora >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
       AND h.usuario_id IS NOT NULL
     ORDER BY h.fecha_hora DESC LIMIT 10`,
  )
  console.log(`\nCon usuario_id NOT NULL (top 10):`)
  for (const r of withUser) {
    console.log(`  ${r.fecha_hora} · usuario_id=${r.usuario_id} (${r.nombre ?? 'NO EN usuario'}) · ${r.tipo}: ${r.accion?.slice(0, 60)}`)
  }

  const [sample] = await conn.query<any[]>(
    `SELECT fecha_hora FROM historial ORDER BY fecha_hora DESC LIMIT 1`,
  )
  console.log(`\nMuestra de fecha_hora (raw): ${sample[0].fecha_hora} · typeof: ${typeof sample[0].fecha_hora}`)
  console.log(`  toString: ${sample[0].fecha_hora?.toString?.() ?? sample[0].fecha_hora}`)

  await conn.end()
}
main().catch((e) => { console.error(e); process.exit(1) })
