import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { env, isProd } from './config/env'
import { apiRouter } from './routes'
import { errorHandler, notFound } from './middleware/error'
import { bgCapture } from './lib/backgroundCapture'
import { startUptimeMonitor, stopUptimeMonitor } from './lib/uptimeMonitor'

const app = express()

app.use(helmet())
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || env.CORS_ORIGINS.includes(origin)) return cb(null, true)
      return cb(new Error(`origin ${origin} not allowed by CORS`))
    },
    credentials: true,
  }),
)
app.use(express.json({ limit: '2mb' }))
app.use(morgan(isProd ? 'combined' : 'dev'))

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'monitoreo-qeb-back',
    env: env.NODE_ENV,
    uptimeSec: Math.round(process.uptime()),
  })
})

// Endpoint temporal — sirve para saber con qué IP sale el back al mundo
// para poder agregarla a Trusted Sources de la DB. Sin auth porque la
// info no es sensible. Remover cuando ya no se necesite.
app.get('/debug/outbound-ip', async (_req, res) => {
  try {
    const r = await fetch('https://ifconfig.me/ip')
    const ip = (await r.text()).trim()
    res.json({ outboundIp: ip })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'error' })
  }
})


app.use('/api', apiRouter)

app.use(notFound)
app.use(errorHandler)

app.listen(env.PORT, () => {
  console.log(`[monitoreo-qeb-back] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`)
  // Captura de logs 24/7 (mientras el proceso esté vivo).
  bgCapture.start()
  // Pinga los 3 targets (front qeb, back qeb via DO, mysql prod) cada 60s.
  startUptimeMonitor()
})

process.on('SIGTERM', () => {
  bgCapture.stop()
  stopUptimeMonitor()
})
process.on('SIGINT', () => {
  bgCapture.stop()
  stopUptimeMonitor()
})
