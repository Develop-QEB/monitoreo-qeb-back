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

  // Integraciones de infra · todas opcionales. Si falta alguna,
  // los endpoints devuelven { configured: false } sin romper.
  VERCEL_TOKEN: process.env.VERCEL_TOKEN,
  VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID, // ID del proyecto de front-qeb en Vercel
  VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID,       // opcional si el proyecto vive en un team
  DO_API_TOKEN: process.env.DO_API_TOKEN,
  DO_APP_ID_QEB_BACK: process.env.DO_APP_ID_QEB_BACK, // UUID del App qeb-back en DO
  DO_DB_CLUSTER_ID: process.env.DO_DB_CLUSTER_ID,     // UUID del cluster qeb-mysql-prod en DO

  // DigitalOcean Spaces (bucket qeb-media-main), S3-compatible.
  DO_SPACES_KEY: process.env.DO_SPACES_KEY,
  DO_SPACES_SECRET: process.env.DO_SPACES_SECRET,
  DO_SPACES_BUCKET: process.env.DO_SPACES_BUCKET ?? 'qeb-media-main',
  DO_SPACES_REGION: process.env.DO_SPACES_REGION ?? 'sfo3',
}

export const isProd = env.NODE_ENV === 'production'
