// Verificación rápida de que el uptime monitor esta insertando pings.
// Correr con: npx ts-node scripts/check-pings.ts
import { PrismaClient } from '@prisma/client'
import * as dotenv from 'dotenv'

dotenv.config()

const prisma = new PrismaClient()

async function main() {
  const total = await prisma.uptimePing.count()
  const rows = await prisma.uptimePing.findMany({
    orderBy: { ts: 'desc' },
    take: 10,
  })
  console.log(`Total pings: ${total}`)
  for (const r of rows) {
    console.log(
      `${r.ts.toISOString()} · ${r.target.padEnd(10)} · ${r.ok ? 'OK  ' : 'FAIL'} · ${String(r.responseMs).padStart(5)}ms · status=${r.status ?? '-'} · err=${r.error ?? '-'}`,
    )
  }
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
