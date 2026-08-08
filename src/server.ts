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

app.use('/api', apiRouter)

app.use(notFound)
app.use(errorHandler)

app.listen(env.PORT, () => {
  console.log(`[monitoreo-qeb-back] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`)
})
