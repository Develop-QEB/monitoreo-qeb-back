// Verifica si session_locks tiene datos y cuando fue el ultimo lock.
// Correr con: npx ts-node scripts/check-session-locks.ts
import * as dotenv from 'dotenv'
import mysql from 'mysql2/promise'

dotenv.config()

async function main() {
  const url = process.env.DATABASE_URL_QEB
  if (!url) throw new Error('DATABASE_URL_QEB no seteado')
  const withSsl = url + (url.includes('?') ? '&' : '?') + 'ssl={"rejectUnauthorized":false}'
  const conn = await mysql.createConnection(withSsl)

  const [total] = await conn.query<any[]>('SELECT COUNT(*) as n FROM session_locks')
  console.log(`Total filas session_locks: ${total[0].n}`)

  const [last] = await conn.query<any[]>(
    'SELECT id, module_name, username, locked_at, TIMESTAMPDIFF(HOUR, locked_at, NOW()) as h_ago FROM session_locks ORDER BY locked_at DESC LIMIT 10',
  )
  console.log('Últimos 10 locks (cualquier fecha):')
  for (const r of last) {
    console.log(
      `  ${r.locked_at} · ${String(r.h_ago).padStart(5)}h atrás · ${r.username ?? '?'} → ${r.module_name}`,
    )
  }

  const [last24] = await conn.query<any[]>(
    'SELECT COUNT(*) as n FROM session_locks WHERE locked_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)',
  )
  console.log(`En las últimas 24h: ${last24[0].n}`)

  const [nowInfo] = await conn.query<any[]>('SELECT NOW() as db_now, @@time_zone as tz')
  console.log(`DB now: ${nowInfo[0].db_now} · timezone: ${nowInfo[0].tz}`)

  await conn.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
