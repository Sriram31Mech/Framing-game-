/**
 * @bh/core — server-only game core. Never import from the client.
 */
export * from './config';
export * from './errors';
export * from './db/pool';
export * from './db/tx';
export * from './db/migrate';
export * from './ledger/ledger';
export * from './events/events';
export * from './world/clock';
export * from './commands/types';
// OWNER: backend agent — commands, queries, auth, world bootstrap
export * from './backend';
// OWNER: simulation agent — daily tick, offline catch-up, reconciliation, AI companies
export * from './simulation';
export * from './ai';
