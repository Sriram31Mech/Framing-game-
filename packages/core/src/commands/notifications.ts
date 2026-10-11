/** Notification housekeeping. */
import { DomainError } from '../errors';
import type { CommandContext } from './context';
import type { GameCommand } from './types';

type Cmd<T extends GameCommand['type']> = Extract<GameCommand, { type: T }>;

export async function markNotificationsRead(
  ctx: CommandContext,
  cmd: Cmd<'mark_notifications_read'>,
) {
  if (!cmd.all && (!cmd.ids || cmd.ids.length === 0)) {
    throw new DomainError('VALIDATION_FAILED', 'Specify notification ids or all: true');
  }
  const res = await ctx.client.query(
    `UPDATE notifications SET read_at = now()
     WHERE company_id = $1 AND read_at IS NULL AND ($2::boolean OR id = ANY($3::uuid[]))`,
    [ctx.actor.companyId, cmd.all === true, cmd.ids ?? []],
  );
  return { updated: res.rowCount ?? 0 };
}
