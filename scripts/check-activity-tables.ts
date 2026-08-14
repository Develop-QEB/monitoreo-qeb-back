// Explora tablas candidatas para "actividad reciente de usuarios"
import * as dotenv from 'dotenv'
import mysql from 'mysql2/promise'

dotenv.config()

async function main() {
  const url = process.env.DATABASE_URL_QEB
  if (!url) throw new Error('DATABASE_URL_QEB no seteado')
  const withSsl = url + (url.includes('?') ? '&' : '?') + 'ssl={"rejectUnauthorized":false}'
  const conn = await mysql.createConnection(withSsl)

  const candidates = ['historial', 'chatbot_logs', 'tickets', 'ticket_mensajes', 'ticket_vistas', 'notas_personales', 'solicitud']

  for (const table of candidates) {
    console.log(`\n== ${table} ==`)
    try {
      // Columnas
      const [cols] = await conn.query<any[]>(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [table],
      )
      console.log(`  cols: ${cols.map((c: any) => c.COLUMN_NAME).join(', ')}`)

      // Filas totales
      const [count] = await conn.query<any[]>(`SELECT COUNT(*) as n FROM \`${table}\``)
      console.log(`  total: ${count[0].n}`)

      // Ultimas 3 filas (para ver estructura)
      const dateCols = cols.filter((c: any) =>
        ['created_at', 'fecha', 'timestamp', 'ts', 'date'].some((k) =>
          c.COLUMN_NAME.toLowerCase().includes(k),
        ),
      )
      const dateCol = dateCols[0]?.COLUMN_NAME
      if (dateCol) {
        const [recent] = await conn.query<any[]>(
          `SELECT * FROM \`${table}\` ORDER BY \`${dateCol}\` DESC LIMIT 3`,
        )
        for (const r of recent) {
          const dt = r[dateCol]
          console.log(`  ${dt}: ${JSON.stringify(r).slice(0, 150)}`)
        }
      }
    } catch (e) {
      console.log(`  ERROR: ${(e as Error).message.slice(0, 100)}`)
    }
  }

  await conn.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
