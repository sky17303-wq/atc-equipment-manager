#!/bin/bash
# equipment_manager DB 일일 백업 (포터블 PostgreSQL 16, 포트 5433)
# 크론 예: 20 4 * * * /opt/equipment-manager/scripts/backup-db.sh >> /var/log/equipment-backup.log 2>&1
set -euo pipefail

PG_BIN=/var/www/postgres/usr/lib/postgresql/16/bin
export LD_LIBRARY_PATH=/var/www/postgres/usr/lib/x86_64-linux-gnu

ENV_FILE=/opt/equipment-manager/.env
BACKUP_DIR=/var/backups/equipment-manager
KEEP_DAYS=14

PGHOST=$(grep '^PGHOST=' "$ENV_FILE" | cut -d= -f2-)
PGPORT=$(grep '^PGPORT=' "$ENV_FILE" | cut -d= -f2-)
PGDATABASE=$(grep '^PGDATABASE=' "$ENV_FILE" | cut -d= -f2-)
PGUSER=$(grep '^PGUSER=' "$ENV_FILE" | cut -d= -f2-)
export PGPASSWORD=$(grep '^PGPASSWORD=' "$ENV_FILE" | cut -d= -f2-)

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d_%H%M%S)
OUT="$BACKUP_DIR/equipment_manager_$STAMP.sql.gz"

"$PG_BIN/pg_dump" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" | gzip > "$OUT"

find "$BACKUP_DIR" -name 'equipment_manager_*.sql.gz' -mtime +"$KEEP_DAYS" -delete

echo "$(date '+%F %T') backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
