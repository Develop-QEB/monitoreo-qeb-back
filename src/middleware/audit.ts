import { prisma } from '../lib/prisma'
import type { AuditActionKind } from '../modules/audit'

export async function recordAudit(input: {
  actor: string
  action: AuditActionKind
  target?: string
  details?: string
}) {
  try {
    await prisma.auditEvent.create({ data: input })
  } catch (err) {
    console.error('[audit] failed to record', input, err)
  }
}
