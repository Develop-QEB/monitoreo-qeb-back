import * as dotenv from 'dotenv'
import mysql from 'mysql2/promise'
dotenv.config()
async function main() {
  const url = process.env.DATABASE_URL_QEB!
  const conn = await mysql.createConnection(url + (url.includes('?') ? '&' : '?') + 'ssl={"rejectUnauthorized":false}')
  for (const t of ['tickets', 'ticket_mensajes', 'solicitud']) {
    const [r] = await conn.query<any[]>(`SELECT COUNT(*) as n, COUNT(usuario_id) as with_user FROM \`${t}\` WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`)
    console.log(`${t} en 24h:`, r[0])
  }
  await conn.end()
}
main().catch(console.error)
