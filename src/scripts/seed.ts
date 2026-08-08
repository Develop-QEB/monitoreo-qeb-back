import { prisma } from '../lib/prisma'
import { hashPassword } from '../lib/password'

const SEED = [
  { name: 'Akary',                email: 'develop@qeb.mx', password: 'changeme', role: 'admin' },
  { name: 'TI Demo',              email: 'ti@qeb.mx',      password: 'changeme', role: 'ti' },
  { name: 'Mejora Continua Demo', email: 'mejora@qeb.mx',  password: 'changeme', role: 'mejora-continua' },
]

async function main() {
  const count = await prisma.user.count()
  if (count > 0) {
    console.log(`[seed] tabla users ya tiene ${count} registros, no hago nada`)
    return
  }

  for (const u of SEED) {
    const passwordHash = await hashPassword(u.password)
    await prisma.user.create({
      data: {
        name: u.name,
        email: u.email,
        passwordHash,
        role: u.role,
        active: true,
      },
    })
    console.log(`[seed] creado ${u.email} (${u.role})`)
  }
  console.log('[seed] listo')
}

main()
  .catch((e) => {
    console.error('[seed] error', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
