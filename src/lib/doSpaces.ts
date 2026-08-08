import {
  S3Client,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  type _Object,
} from '@aws-sdk/client-s3'
import { env } from '../config/env'

export function doSpacesConfigured(): boolean {
  return !!(env.DO_SPACES_KEY && env.DO_SPACES_SECRET && env.DO_SPACES_BUCKET)
}

let client: S3Client | null = null

function getClient(): S3Client {
  if (client) return client
  if (!env.DO_SPACES_KEY || !env.DO_SPACES_SECRET) {
    throw new Error('DO_SPACES_KEY / DO_SPACES_SECRET no configuradas')
  }
  client = new S3Client({
    region: env.DO_SPACES_REGION,
    endpoint: `https://${env.DO_SPACES_REGION}.digitaloceanspaces.com`,
    credentials: {
      accessKeyId: env.DO_SPACES_KEY,
      secretAccessKey: env.DO_SPACES_SECRET,
    },
  })
  return client
}

export interface SpacesObject {
  key: string
  size: number
  lastModified: string | null
}

/**
 * Lista TODOS los objetos del bucket (con paginación).
 * Para buckets muy grandes, cortar con `maxTotal`.
 */
export async function listAllObjects(maxTotal = 5000): Promise<SpacesObject[]> {
  const c = getClient()
  const objects: SpacesObject[] = []
  let continuationToken: string | undefined = undefined

  while (objects.length < maxTotal) {
    const res: ListObjectsV2CommandOutput = await c.send(
      new ListObjectsV2Command({
        Bucket: env.DO_SPACES_BUCKET!,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      }),
    )
    const batch = (res.Contents ?? []).map((o: _Object) => ({
      key: o.Key ?? '',
      size: o.Size ?? 0,
      lastModified: o.LastModified ? o.LastModified.toISOString() : null,
    }))
    objects.push(...batch)
    if (!res.IsTruncated || !res.NextContinuationToken) break
    continuationToken = res.NextContinuationToken
  }
  return objects.slice(0, maxTotal)
}

export interface SpacesSummary {
  bucket: string
  region: string
  endpoint: string
  totalObjects: number
  totalBytes: number
  totalGiB: number
  byExtension: { ext: string; count: number; bytes: number }[]
  byTopLevel: { prefix: string; count: number; bytes: number }[]
  largest: SpacesObject[]
  mostRecent: SpacesObject[]
  oldestAt: string | null
  newestAt: string | null
}

function extOf(key: string): string {
  const idx = key.lastIndexOf('.')
  if (idx === -1 || idx === key.length - 1) return '(sin ext)'
  return key.slice(idx + 1).toLowerCase()
}

function topLevelPrefixOf(key: string): string {
  const idx = key.indexOf('/')
  if (idx === -1) return '(raíz)'
  return key.slice(0, idx)
}

export async function getSpacesSummary(): Promise<SpacesSummary> {
  const objects = await listAllObjects(10_000)

  const totalBytes = objects.reduce((sum, o) => sum + o.size, 0)
  const totalObjects = objects.length

  // Agregación por extensión
  const extMap = new Map<string, { count: number; bytes: number }>()
  const prefixMap = new Map<string, { count: number; bytes: number }>()
  for (const o of objects) {
    const ext = extOf(o.key)
    const cur = extMap.get(ext) ?? { count: 0, bytes: 0 }
    cur.count += 1
    cur.bytes += o.size
    extMap.set(ext, cur)

    const p = topLevelPrefixOf(o.key)
    const pcur = prefixMap.get(p) ?? { count: 0, bytes: 0 }
    pcur.count += 1
    pcur.bytes += o.size
    prefixMap.set(p, pcur)
  }

  const byExtension = Array.from(extMap.entries())
    .map(([ext, v]) => ({ ext, ...v }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 20)

  const byTopLevel = Array.from(prefixMap.entries())
    .map(([prefix, v]) => ({ prefix, ...v }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 20)

  const largest = [...objects].sort((a, b) => b.size - a.size).slice(0, 20)
  const withDate = objects.filter((o) => !!o.lastModified)
  const mostRecent = [...withDate]
    .sort(
      (a, b) => new Date(b.lastModified!).getTime() - new Date(a.lastModified!).getTime(),
    )
    .slice(0, 20)

  const timestamps = withDate.map((o) => new Date(o.lastModified!).getTime())
  const oldestAt = timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null
  const newestAt = timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null

  return {
    bucket: env.DO_SPACES_BUCKET!,
    region: env.DO_SPACES_REGION,
    endpoint: `https://${env.DO_SPACES_BUCKET!}.${env.DO_SPACES_REGION}.digitaloceanspaces.com`,
    totalObjects,
    totalBytes,
    totalGiB: totalBytes / 1024 / 1024 / 1024,
    byExtension,
    byTopLevel,
    largest,
    mostRecent,
    oldestAt,
    newestAt,
  }
}
