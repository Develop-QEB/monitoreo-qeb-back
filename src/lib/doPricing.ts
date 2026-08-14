// Precios oficiales de DigitalOcean (USD/mes) para los slugs mas comunes.
// Actualizado 2026-08. Fuente: https://www.digitalocean.com/pricing
// Solo hay que actualizarlo si DO cambia precios o si aparece un slug nuevo.

// App Platform · precios por instancia (instance_size_slug).
// Ver https://docs.digitalocean.com/products/app-platform/details/pricing/
// Los slugs "apps-*" son la nomenclatura moderna (2024+). Los "basic-*"/"professional-*"
// son legacy pero siguen apareciendo en algunas apps antiguas.
const APP_TIER_USD: Record<string, number> = {
  // Legacy Basic
  'basic-xxs': 5,
  'basic-xs': 12,
  'basic-s': 25,
  'basic-m': 50,
  // Legacy Professional
  'professional-xs': 34,
  'professional-s': 78,
  'professional-m': 156,
  'professional-1l': 105,
  'professional-2l': 210,

  // Moderna: Basic (shared CPU) apps-s-*
  'apps-s-1vcpu-0.5gb': 5,
  'apps-s-1vcpu-1gb': 12,
  'apps-s-1vcpu-2gb': 25,
  'apps-s-2vcpu-4gb': 50,

  // Moderna: Professional (dedicated CPU) apps-d-*
  'apps-d-1vcpu-1gb': 34,
  'apps-d-1vcpu-2gb': 49,
  'apps-d-1vcpu-4gb': 78,
  'apps-d-2vcpu-4gb': 102,
  'apps-d-2vcpu-8gb': 155,
  'apps-d-4vcpu-8gb': 204,
  'apps-d-4vcpu-16gb': 312,
  'apps-d-8vcpu-16gb': 408,
  'apps-d-8vcpu-32gb': 624,
}

// Managed Databases · slugs "db-s-<vcpu>-<ram>" mas comunes en region SFO/NYC.
// Ver https://www.digitalocean.com/pricing/managed-databases
const DB_SIZE_USD: Record<string, number> = {
  'db-s-1vcpu-1gb': 15,
  'db-s-1vcpu-2gb': 30,
  'db-s-2vcpu-4gb': 60,
  'db-s-4vcpu-8gb': 120,
  'db-s-6vcpu-16gb': 240,
  'db-s-8vcpu-32gb': 480,
  // gp = general purpose
  'gd-2vcpu-8gb': 155,
  'gd-4vcpu-16gb': 310,
}

export interface PlanInfo {
  slug: string
  usdPerMonth: number | null
  known: boolean
}

export function estimateAppPlan(
  instanceSizeSlug: string | undefined | null,
  instanceCount: number = 1,
  tierSlugFallback?: string | undefined | null,
): PlanInfo {
  // Preferimos siempre instance_size_slug: es lo que DO cobra por instancia.
  // tierSlug (ej "professional") solo dice familia y no aparea a un precio.
  const slug = instanceSizeSlug ?? tierSlugFallback ?? null
  if (!slug) return { slug: '—', usdPerMonth: null, known: false }
  const perInstance = APP_TIER_USD[slug]
  const total = perInstance !== undefined ? perInstance * Math.max(1, instanceCount) : null
  return {
    slug: instanceCount > 1 ? `${slug} × ${instanceCount}` : slug,
    usdPerMonth: total,
    known: perInstance !== undefined,
  }
}

export function estimateDbPlan(
  sizeSlug: string | undefined | null,
  numNodes: number = 1,
): PlanInfo {
  if (!sizeSlug) return { slug: '—', usdPerMonth: null, known: false }
  const perNode = DB_SIZE_USD[sizeSlug]
  return {
    slug: sizeSlug,
    usdPerMonth: perNode !== undefined ? perNode * Math.max(1, numNodes) : null,
    known: perNode !== undefined,
  }
}
