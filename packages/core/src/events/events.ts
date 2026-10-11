import type { EventType } from '@bh/contracts';
import type { DbClient } from '../db/pool';

export interface EmitEventInput {
  regionId: string;
  type: EventType;
  gameDay: number;
  /** Recipient company for private events; null = public to the whole region. */
  companyId: string | null;
  actorCompanyId?: string | null;
  entityType?: string;
  entityId?: string;
  payload?: Record<string, unknown>;
}

/**
 * Append a domain event (outbox + audit trail) in the caller's transaction. A trigger NOTIFYs
 * realtime gateways after commit, so events are only delivered for committed state.
 */
export async function emitEvent(client: DbClient, e: EmitEventInput): Promise<number> {
  const { rows } = await client.query<{ seq: number }>(
    `INSERT INTO domain_events (region_id, type, company_id, actor_company_id, entity_type, entity_id, payload, game_day)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING seq`,
    [
      e.regionId,
      e.type,
      e.companyId,
      e.actorCompanyId ?? null,
      e.entityType ?? null,
      e.entityId ?? null,
      JSON.stringify(e.payload ?? {}),
      e.gameDay,
    ],
  );
  return rows[0]!.seq;
}

export interface NotifyInput {
  regionId: string;
  companyId: string;
  type: string;
  severity?: 'info' | 'success' | 'warning' | 'danger';
  title: string;
  body: string;
  gameDay: number;
  entityType?: string;
  entityId?: string;
  /** Duplicate suppression: a second notification with the same key for the company is dropped. */
  dedupeKey?: string;
}

/** Create a persistent notification (deduplicated) and emit `notification.created`. */
export async function notify(client: DbClient, n: NotifyInput): Promise<string | null> {
  const { rows } = await client.query<{
    id: string;
    created_at: Date;
  }>(
    `INSERT INTO notifications (company_id, type, severity, title, body, entity_type, entity_id, dedupe_key, game_day)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (company_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id, created_at`,
    [
      n.companyId,
      n.type,
      n.severity ?? 'info',
      n.title,
      n.body,
      n.entityType ?? null,
      n.entityId ?? null,
      n.dedupeKey ?? null,
      n.gameDay,
    ],
  );
  const row = rows[0];
  if (!row) return null;
  await emitEvent(client, {
    regionId: n.regionId,
    type: 'notification.created',
    gameDay: n.gameDay,
    companyId: n.companyId,
    entityType: 'notification',
    entityId: row.id,
    payload: {
      id: row.id,
      type: n.type,
      severity: n.severity ?? 'info',
      title: n.title,
      body: n.body,
      entityType: n.entityType ?? null,
      entityId: n.entityId ?? null,
      gameDay: n.gameDay,
      createdAt: row.created_at.toISOString(),
      read: false,
    },
  });
  return row.id;
}
