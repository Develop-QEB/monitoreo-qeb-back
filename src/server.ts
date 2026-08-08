import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { env, isProd } from './config/env'
import { apiRouter } from './routes'
import { errorHandler, notFound } from './middleware/error'

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

// Endpoint temporal — compara process.env vs env module vs configured flags.
app.get('/debug/env-check', (_req, res) => {
  res.json({
    processEnv: {
      VERCEL_TOKEN:        !!process.env.VERCEL_TOKEN,
      VERCEL_PROJECT_ID:   !!process.env.VERCEL_PROJECT_ID,
      DO_API_TOKEN:        !!process.env.DO_API_TOKEN,
      DO_APP_ID_QEB_BACK:  !!process.env.DO_APP_ID_QEB_BACK,
      DO_DB_CLUSTER_ID:    !!process.env.DO_DB_CLUSTER_ID,
    },
    envModule: {
      VERCEL_TOKEN:        !!env.VERCEL_TOKEN,
      VERCEL_PROJECT_ID:   !!env.VERCEL_PROJECT_ID,
      DO_API_TOKEN:        !!env.DO_API_TOKEN,
      DO_APP_ID_QEB_BACK:  !!env.DO_APP_ID_QEB_BACK,
      DO_DB_CLUSTER_ID:    !!env.DO_DB_CLUSTER_ID,
    },
    configured: {
      vercel: !!(env.VERCEL_TOKEN && env.VERCEL_PROJECT_ID),
      doApp:  !!(env.DO_API_TOKEN && env.DO_APP_ID_QEB_BACK),
      doDb:   !!(env.DO_API_TOKEN && env.DO_DB_CLUSTER_ID),
    },
    lengths: {
      VERCEL_TOKEN:        env.VERCEL_TOKEN?.length ?? 0,
      VERCEL_PROJECT_ID:   env.VERCEL_PROJECT_ID?.length ?? 0,
      DO_API_TOKEN:        env.DO_API_TOKEN?.length ?? 0,
      DO_APP_ID_QEB_BACK:  env.DO_APP_ID_QEB_BACK?.length ?? 0,
      DO_DB_CLUSTER_ID:    env.DO_DB_CLUSTER_ID?.length ?? 0,
    },
  })
})

app.use('/api', apiRouter)

app.use(notFound)
app.use(errorHandler)

app.listen(env.PORT, () => {
  console.log(`[monitoreo-qeb-back] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`)
})
