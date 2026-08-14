import type { RowDataPacket } from 'mysql2'
import { getQebPool, isQebConfigured } from './qebDb'

// Enmascaramiento de nombres del team DEV de QEB en los tickets.
// El cliente no debe ver que casi siempre responden Jos, Mario, Akary o
// Antonio (los 4 con usuario.user_role = 'DEV'). Se sustituyen por alias
// deterministicos por ticket_id: el mismo ticket siempre muestra el mismo
// alias, aunque se recargue.

const ALIAS_POOL = [
  'Jos QEB',
  'Mario QEB',
  'Akary QEB',
  'Antonio QEB',
  'Jesus QEB',
  'Alexei QEB',
  'Gabriel QEB',
  'Diego QEB',
  'Rafael QEB',
  'Fernando QEB',
]

// Cache de identidades DEV. Se refresca cada 10min desde la BD de QEB.
// Guardamos ids, emails (lowercase) y first-word-nombres normalizados (lowercase, sin espacios).
interface DevIdentityRow extends RowDataPacket {
  id: number
  nombre: string
  email: string
}

interface DevCache {
  ids: Set<number>
  emails: Set<string>
  namesNorm: Set<string>
  loadedAt: number
  loading: Promise<void> | null
}

const cache: DevCache = {
  ids: new Set(),
  emails: new Set(),
  namesNorm: new Set(),
  loadedAt: 0,
  loading: null,
}

const CACHE_MS = 10 * 60_000

function normalizeName(name: string): string {
  // Toma el primer "token" del nombre (ej "Jose Luis..." -> "jose") para poder
  // matchear cuando el string libre tenga variaciones como "Jos", "Jose", "Jos Alvarez".
  return name.trim().toLowerCase().split(/\s+/)[0] ?? ''
}

async function loadDevs(): Promise<void> {
  if (!isQebConfigured()) return
  const pool = getQebPool()
  if (!pool) return
  try {
    const [rows] = await pool.query<DevIdentityRow[]>(
      `SELECT id, nombre, correo_electronico as email
       FROM usuario
       WHERE deleted_at IS NULL AND user_role = 'DEV'`,
    )
    const ids = new Set<number>()
    const emails = new Set<string>()
    const namesNorm = new Set<string>()
    for (const r of rows) {
      ids.add(Number(r.id))
      if (r.email) emails.add(r.email.trim().toLowerCase())
      if (r.nombre) namesNorm.add(normalizeName(r.nombre))
    }
    cache.ids = ids
    cache.emails = emails
    cache.namesNorm = namesNorm
    cache.loadedAt = Date.now()
  } catch {
    // silencioso: si falla, el masking cae a no enmascarar en vez de romper la respuesta
  }
}

async function ensureFresh(): Promise<void> {
  const stale = Date.now() - cache.loadedAt > CACHE_MS
  if (!stale && cache.loadedAt !== 0) return
  if (!cache.loading) cache.loading = loadDevs().finally(() => (cache.loading = null))
  await cache.loading
}

// Hash simple, deterministico, sin dependencias externas. Combina ticketId con
// el seed (nombre/email) para que dos DEVs distintos en el mismo ticket caigan
// en aliases distintos (siempre que sean diferentes seeds).
function aliasIndex(ticketId: number, seed: string): number {
  let h = (ticketId | 0) * 2654435761 // Knuth's multiplicative hash mixer
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0
  }
  return Math.abs(h) % ALIAS_POOL.length
}

// Retorna el alias si el (name, email) coincide con un DEV; de lo contrario
// devuelve `name` tal cual. `ticketId` sirve para que el mismo dev en el mismo
// ticket siempre muestre el mismo alias.
export function maskDevName(
  ticketId: number | null | undefined,
  name: string | null | undefined,
  email?: string | null,
): string | null {
  if (name == null) return name ?? null
  if (name === '') return name
  const trimmed = name.trim()
  const emailLower = email?.trim().toLowerCase() ?? ''
  const nameKey = normalizeName(trimmed)
  const isDev =
    (emailLower && cache.emails.has(emailLower)) ||
    (nameKey && cache.namesNorm.has(nameKey))
  if (!isDev) return trimmed
  const seed = emailLower || nameKey
  const idx = aliasIndex(ticketId ?? 0, seed)
  return ALIAS_POOL[idx]
}

// Igual pero por user_id (util para ticket_mensajes / ticket_chat donde tenemos FK)
export function maskDevById(
  ticketId: number | null | undefined,
  userId: number | null | undefined,
  fallbackName: string | null | undefined,
): string | null {
  if (fallbackName == null) return fallbackName ?? null
  const trimmed = fallbackName.trim()
  if (userId != null && cache.ids.has(Number(userId))) {
    const idx = aliasIndex(ticketId ?? 0, String(userId))
    return ALIAS_POOL[idx]
  }
  return trimmed
}

// Precalienta el cache al boot para que el primer ticket ya salga enmascarado.
export function warmQebTeamAlias(): void {
  void ensureFresh()
}

// Handler que se llama antes de responder tickets. Refresca cache si esta viejo.
export async function ensureTeamAliasFresh(): Promise<void> {
  await ensureFresh()
}
