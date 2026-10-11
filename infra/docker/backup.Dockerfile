# Backup sidecar: PostgreSQL 17 client tools + scripts/backup*.sh / restore*.sh.
# Built from the repository root (see infra/docker/compose.prod.yml):
#   docker build -f infra/docker/backup.Dockerfile -t bharat-harvest/backup .
# pg_dump must be >= the server major version, so keep this in step with infra/docker/db/Dockerfile.
FROM postgres:17-bookworm

COPY scripts/lib/pg.sh /opt/bh/scripts/lib/pg.sh
COPY scripts/backup.sh scripts/restore.sh scripts/restore-test.sh scripts/backup-loop.sh /opt/bh/scripts/

RUN chmod 0755 /opt/bh/scripts/*.sh \
 && mkdir -p /backups \
 && chown postgres:postgres /backups \
 && chmod 0700 /backups

ENV BACKUP_DIR=/backups \
    BH_PG_MODE=native \
    BACKUP_MAX_AGE_HOURS=26

USER postgres
WORKDIR /backups
VOLUME ["/backups"]

# Unhealthy when the newest dump is older than BACKUP_MAX_AGE_HOURS (missed/failed backups).
HEALTHCHECK --interval=5m --timeout=10s --start-period=15m --retries=1 \
  CMD find /backups -maxdepth 1 -name '*.dump' -mmin "-$((BACKUP_MAX_AGE_HOURS * 60))" | grep -q . || exit 1

ENTRYPOINT []
CMD ["/opt/bh/scripts/backup-loop.sh"]
