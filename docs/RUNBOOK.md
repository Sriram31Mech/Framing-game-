# Operations Runbook — Bharat Harvest

Production is one VPS running `infra/docker/compose.prod.yml` (db, migrate, server, worker, caddy,
backup). All commands below assume the repository is checked out on the host at the release being
run and use this alias:

```bash
alias bhc='docker compose -f infra/docker/compose.prod.yml --env-file infra/docker/.env.production'
```

Environments: **dev** (laptop, `docker-compose.yml`), **staging** (same compose file on a separate
host/domain, `APP_ENV=staging`), **production**. Never point staging at production data; restore a
backup into staging instead.

---

## 1. First-time setup

1. Provision Ubuntu/Debian LTS, 2 vCPU / 4 GB RAM / 40+ GB SSD. Enable automatic security updates,
   SSH keys only, firewall allowing 22, 80, 443 (tcp) and 443 (udp).
2. Install Docker Engine + Compose v2. Point `DOMAIN`'s A/AAAA records at the host.
3. `git clone` the repository; `cp infra/docker/production.env.example infra/docker/.env.production`;
   `chmod 600` it; fill in `DOMAIN`, `ACME_EMAIL`, `POSTGRES_PASSWORD` (`openssl rand -hex 24`),
   `SESSION_SECRET` (`openssl rand -hex 32`), `PUBLIC_CLIENT_URL=https://$DOMAIN`, Steam values if
   used. Optional off-site backup credentials go in `infra/docker/.env.backup`.
4. `bhc build && bhc up -d`, then `bhc ps` — all services `healthy` (migrate `exited (0)`).
5. Bootstrap the world once (region, markets, AI companies):
   `bhc run --rm --no-deps server node packages/core/dist/seed.js` (the image bundles
   `packages/core/src/db/seed-cli.ts`; it must be idempotent so re-running is harmless).
6. Check `https://$DOMAIN/healthz`, sign in, and confirm `bhc logs worker` shows ticks.

## 2. Deploy

Releases are git commits on `main` that passed CI.

```bash
git fetch && git checkout <sha>            # or: git pull --ff-only
bhc build server                           # builds the app image (migrate/worker reuse it)
bhc run --rm backup /opt/bh/scripts/backup.sh   # pre-deploy backup (always)
bhc up -d                                  # migrate runs first; server/worker restart after it
bhc ps && curl -fsS https://$DOMAIN/healthz
```

- Downtime: the server restarts (a few seconds); clients reconnect and refetch. The worker catches up
  missed days automatically from its checkpoints.
- With a registry: build in CI, push `ghcr.io/<owner>/bharat-harvest:<sha>`, set
  `APP_IMAGE=...:<sha>` in `.env.production`, `bhc pull && bhc up -d`.
- Watch logs for 10 minutes: `bhc logs -f --since 10m server worker`.

## 3. Rollback

1. **Code-only release** (no new migration): `git checkout <previous-sha> && bhc build server &&
   bhc up -d` (or set `APP_IMAGE` back to the previous tag).
2. **Release with migrations**: migrations are forward-only (§4). Prefer a fix-forward. If the new
   schema is incompatible with the old code, restore the pre-deploy backup:
   ```bash
   bhc stop server worker
   bhc run --rm backup /opt/bh/scripts/restore.sh --target-db bharat_harvest --drop-existing --yes \
     /backups/<pre-deploy-file>.dump
   git checkout <previous-sha> && bhc build server && bhc up -d
   ```
   Data written after the backup is lost — announce it. The world clock catches up from the restored
   checkpoint.

## 4. Migrations policy

- Plain SQL files `infra/migrations/NNNN_name.sql`, applied in order by the `migrate` service under an
  advisory lock, each in its own transaction, recorded with a SHA-256 in `schema_migrations`.
- **Never edit an applied migration** — the runner refuses checksum changes. Add a new file.
- Forward-only, and **expand → migrate → contract**: add columns/tables nullable or with defaults,
  deploy code that writes both, backfill, then drop old structures in a later release. This keeps
  the previous release runnable for rollback.
- Long operations (`CREATE INDEX` on big tables) belong in their own migration; prefer
  `CREATE INDEX CONCURRENTLY` in a migration file containing only that statement.
- Money columns are `BIGINT` paise; every ledger change must keep `findLedgerMismatches` empty.
- Running a migration manually: `bhc run --rm migrate`.
- Ad-hoc SQL: `bhc exec db psql -U bh bharat_harvest`. Writes to economic tables outside the
  command layer are forbidden except during an incident with a recorded ledger correction (§7.3).

## 5. Backups and restore

| What               | Where / how                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------- |
| Daily dump         | `backup` service at `BACKUP_AT` (UTC): `pg_dump -Fc` → volume `bh_backups` + `.sha256`        |
| Retention          | `BACKUP_RETENTION_DAYS` (14), never fewer than `BACKUP_MIN_KEEP` (3) newest                   |
| Off-site           | `BACKUP_UPLOAD_CMD` hook (rclone/aws/s3cmd …) with credentials in `.env.backup`               |
| Restore drill      | weekly (`RESTORE_DRILL_WEEKDAY`): newest dump → scratch DB → ledger + reconciliation checks    |
| Health             | `backup` container turns `unhealthy` when the newest dump is > 26 h old                       |

Commands:

```bash
bhc run --rm backup /opt/bh/scripts/backup.sh                       # ad-hoc backup
bhc exec backup ls -l /backups                                      # list
bhc cp backup:/backups/<file>.dump ./ && bhc cp backup:/backups/<file>.dump.sha256 ./   # copy out
bhc run --rm backup /opt/bh/scripts/restore-test.sh --from-file /backups/<file>.dump    # drill now
```

**Full restore (disaster recovery):**

1. `bhc stop server worker` (players get 502s from Caddy).
2. Verify the dump: the restore script checks `<file>.sha256`; if restoring from off-site storage,
   download both files.
3. `bhc run --rm backup /opt/bh/scripts/restore.sh --target-db bharat_harvest --drop-existing --yes /backups/<file>.dump`
4. `bhc run --rm backup /opt/bh/scripts/restore-test.sh --from-file /backups/<file>.dump` (checks
   invariants on a scratch copy) and run the reconciliation query (§7.3) on the live DB.
5. `bhc up -d` — migrate applies any newer migrations; the worker catches up the world clock.
6. Record RPO (time of dump) and RTO in the incident log.

**Restore drill (monthly, manual, in addition to the weekly automated one):** restore the latest
off-site copy onto a staging host, start the stack, log in, and verify a company overview. Record
the date and duration here:

| Date | Dump | Duration | Result | By |
| ---- | ---- | -------- | ------ | -- |
|      |      |          |        |    |

Locally, `scripts/restore-test.sh` does the same against the dev database.

## 6. Monitoring

Endpoints: `GET /healthz` (liveness), `GET /readyz` (DB reachable), `GET /api/v1/version`,
`GET /metrics` (Prometheus; blocked at Caddy — scrape from inside the Docker network or via SSH
tunnel), worker metrics on `:9464/metrics` and health on `:9464/healthz` (internal network only).

Logs: JSON (pino / Caddy) via `bhc logs`; rotated by Docker (10 MB × 5 per container). Secrets,
tokens, passwords and Steam tickets are redacted and must never be logged.

Suggested alerts (Prometheus/Grafana, Uptime Kuma, or a cron script against `/metrics`). Worker
metric names come from `apps/worker/src/metrics.ts`; API metric names are illustrative — match them
to the server's `/metrics` output:

| Signal                       | Metric / check                                                   | Alert when                       |
| ---------------------------- | ---------------------------------------------------------------- | -------------------------------- |
| Site down                    | external probe of `https://$DOMAIN/healthz`                      | 2 consecutive failures           |
| Tick backlog                 | worker `bh_worker_tick_backlog_days`                | > 2 for 10 min                   |
| Tick duration                | worker `bh_worker_tick_duration_seconds` p95                                   | > 50% of `REAL_SECONDS_PER_GAME_DAY` |
| Ledger mismatches            | worker `bh_worker_ledger_mismatches`, `bh_worker_reconciliation_issues` | > 0 (page immediately)    |
| Worker loop                  | worker `bh_worker_loop_errors_total` rate, `bh_worker_last_tick_timestamp_seconds`, `/healthz` 503 | errors rising / no tick for 3 game days |
| API errors                   | `http_requests_total{status=~"5.."}` rate                        | > 0.5% of requests over 5 min    |
| API latency                  | `http_request_duration_seconds` p95                              | > 300 ms for 10 min              |
| DB connections               | `SELECT count(*) FROM pg_stat_activity`             | > 80% of `max_connections` (60)  |
| Rate limiting                | `http_requests_total{status="429"}`                              | sudden spike (abuse)             |
| Disk                         | host filesystem / `bh_db_data` volume                            | > 80% used                       |
| Backups                      | `backup` container health / newest dump age                      | unhealthy or > 26 h              |
| Memory                       | `docker stats` vs limits (server 768M, worker 512M, db 1.5G)     | > 90% for 15 min                 |
| Certificates                 | Caddy logs `certificate obtained`/errors                         | renewal errors                   |

## 7. Incidents

Start an incident note (time, symptoms, actions). Take a backup before any manual data change.

### 7.1 Worker stuck / world clock not advancing

Symptoms: `world.gameDay` frozen, tick backlog rising, no `world.time_updated` events.

1. `bhc ps worker`, `bhc logs --since 30m worker` — look for a failing tick (the same day retried) or
   a crash loop.
2. Is the world paused? `SELECT * FROM world_clock;` (`paused = true` stops ticks).
3. Lock held by a dead session? `SELECT pid, state, query_start, query FROM pg_stat_activity WHERE
   application_name LIKE 'bh%';` — a stuck transaction is terminated by
   `idle_in_transaction_session_timeout` (60 s); otherwise `SELECT pg_terminate_backend(<pid>)`.
4. `bhc restart worker`. Ticks are idempotent (checkpoint per day), so restarting is always safe;
   catch-up proceeds in batches of `MAX_CATCHUP_DAYS_PER_BATCH`.
5. A deterministic failure on one day (bad data) needs a code fix — do **not** insert checkpoints by
   hand. Pause the world (`UPDATE world_clock SET paused = true`), fix, deploy, unpause.

### 7.2 Database disk full / DB unavailable

1. `df -h`, `docker system df`. Free space: `docker image prune -a` (old images),
   `docker builder prune`, check `bh_backups` volume size (lower `BACKUP_RETENTION_DAYS`, make sure
   off-site upload works first).
2. Large tables: `SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) FROM
   pg_statio_user_tables ORDER BY 2 DESC LIMIT 10;` — typical growth: `domain_events`,
   `market_price_snapshots`, `ledger_entries`, `idempotency_keys`, `sessions`. Prune expired
   sessions/idempotency keys/events per retention policy; never delete ledger rows.
3. WAL growth: check `max_wal_size` and that no replication slot is retained:
   `SELECT * FROM pg_replication_slots;`.
4. Resize the volume/disk if needed; Postgres recovers once space exists (`bhc restart db`).

### 7.3 Ledger mismatch (`bh_worker_ledger_mismatches > 0` or restore drill failure)

Economic integrity incident — treat as P1.

1. **Freeze economic writes**: `bhc stop server` (or put the server in maintenance), pause the world:
   `UPDATE world_clock SET paused = true;`.
2. Back up immediately (`backup.sh`).
3. Identify:
   ```sql
   -- unbalanced transactions (should be impossible: deferred trigger)
   SELECT transaction_id, SUM(amount_paise) FROM ledger_entries GROUP BY 1 HAVING SUM(amount_paise) <> 0;
   -- denormalised balance vs ledger (findLedgerMismatches)
   WITH sums AS (SELECT company_id, account_code, SUM(amount_paise)::bigint total FROM ledger_entries
                 WHERE company_id IS NOT NULL AND account_code IN ('cash','escrow') GROUP BY 1,2)
   SELECT c.id, a.account, a.denormalised, COALESCE(s.total,0) ledger
   FROM companies c CROSS JOIN LATERAL (VALUES ('cash',c.cash_paise),('escrow',c.escrow_paise)) a(account,denormalised)
   LEFT JOIN sums s ON s.company_id=c.id AND s.account_code=a.account
   WHERE a.denormalised <> COALESCE(s.total,0);
   ```
4. Find the cause from recent `ledger_transactions` / `domain_events` for those companies and the
   deploy history. The ledger is the source of truth; correct the denormalised balance, or post a
   **balanced correcting transaction** (`kind = 'admin_correction'`, description referencing the
   incident) — never edit or delete existing entries.
5. Add a regression test, deploy the fix, unpause, start the server, and notify affected players.

### 7.4 Abuse / rate limiting

1. Identify sources: Caddy JSON logs (`remote_ip`, `uri`, `status`), server logs with 429s, account
   ids in command logs.
2. Built-in limits: auth 10/min/IP, commands 120/min/session, queries 600/min/session. Exploit
   attempts show as many 409/422 and `IDEMPOTENCY_KEY_REUSED`.
3. Block an IP at the edge: add to the site block in `infra/docker/caddy/Caddyfile`
   (`@blocked remote_ip 203.0.113.7` + `respond @blocked 403`), then
   `bhc exec caddy caddy reload --config /etc/caddy/Caddyfile`. Host firewall (`ufw deny from …`)
   for floods.
4. Revoke sessions of an account: `DELETE FROM sessions WHERE account_id = '<uuid>';`.
5. Suspicious economic outcomes (market manipulation, wash trading between own accounts): export the
   trades/ledger for review before any correction; corrections follow §7.3.

### 7.5 Secret rotation

| Secret              | Rotation                                                                                     | Impact                                  |
| ------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------- |
| `SESSION_SECRET`    | set new value in `.env.production`, `bhc up -d server`                                       | **All sessions invalidated** — every player must log in again (tokens are stored as HMACs keyed by the secret). Announce first. |
| `POSTGRES_PASSWORD` | `bhc exec db psql -U bh -c "ALTER USER bh PASSWORD '<new>'"`, update env file, `bhc up -d`    | Brief reconnects                        |
| `STEAM_WEB_API_KEY` | regenerate in Steamworks partner site, update env, `bhc up -d server`                        | Steam logins fail until updated         |
| Backup credentials  | rotate at the storage provider, update `.env.backup`, `bhc up -d backup`                      | none                                    |
| TLS                 | automatic (Caddy); force renewal by removing the cert in `caddy_data` only if compromised    | none                                    |

If a secret was committed to git: rotate it **immediately** (history rewriting does not un-leak a
public repository), then remove it from the tree.

## 8. Scaling path (DESIGN.md §9)

Measure before changing architecture — run `pnpm load` against staging at and above the target
(16 players; also 32 and 64).

1. **Optimise queries and jobs**: `log_min_duration_statement` output, `EXPLAIN ANALYZE`, missing
   indexes, batch tick writes, paginate history endpoints.
2. **Vertical scale**: bigger VPS; raise `shared_buffers` (~25% RAM), `effective_cache_size`
   (~60%), container memory limits and pool sizes.
3. **Read caching and separate workers**: cache static definitions/map responses; run AI decisions in
   a separate worker process (same image, different command).
4. **Managed Postgres** with PITR when affordable (point `DATABASE_URL` at it; drop the `db` service).
5. **Partition background workloads**, then **partition by region** (one worker per region, region
   ids already on every relevant table) — only when metrics justify it.
