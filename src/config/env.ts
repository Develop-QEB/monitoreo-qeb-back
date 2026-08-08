import dotenv from 'dotenv'

dotenv.config()

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env var: ${name}`)
  return v
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: parseInt(process.env.PORT ?? '4001', 10),
  DATABASE_URL: required('DATABASE_URL'),
  DATABASE_URL_QEB: process.env.DATABASE_URL_QEB, // read-only prod, opcional
  JWT_SECRET: required('JWT_SECRET'),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? '8h',
  CORS_ORIGINS: (process.env.CORS_ORIGINS ?? 'http://localhost:5175')
    .split(',')
    .map((s) => s.trim()),
}

export const isProd = env.NODE_ENV === 'production'
