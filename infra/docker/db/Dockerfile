# PostgreSQL 17 + PostGIS 3, multi-arch (amd64 + arm64).
# The upstream postgis/postgis image is amd64-only, so we extend the official postgres image.
FROM postgres:17-bookworm
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-17-postgis-3 \
  && rm -rf /var/lib/apt/lists/*
