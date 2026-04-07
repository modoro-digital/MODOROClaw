#!/bin/bash
# Daily backup script for MODOROClaw workspace
# Run via cron: 0 2 * * * /path/to/workspace/scripts/backup.sh

set -e

WORKSPACE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$WORKSPACE_DIR/backups/$(date +%Y-%m-%d)"

mkdir -p "$BACKUP_DIR"

# Backup configs
cp -r "$WORKSPACE_DIR/config" "$BACKUP_DIR/config"

# Backup core files
for f in USER.md IDENTITY.md SOUL.md AGENTS.md MEMORY.md HEARTBEAT.md; do
    [ -f "$WORKSPACE_DIR/$f" ] && cp "$WORKSPACE_DIR/$f" "$BACKUP_DIR/"
done

# Backup SQLite databases
for db in "$WORKSPACE_DIR/data"/*.db; do
    [ -f "$db" ] && cp "$db" "$BACKUP_DIR/"
done

# Backup memory
cp -r "$WORKSPACE_DIR/memory" "$BACKUP_DIR/memory"

# Cleanup old backups (keep 30 days)
find "$WORKSPACE_DIR/backups" -maxdepth 1 -type d -mtime +30 -exec rm -rf {} \;

echo "Backup complete: $BACKUP_DIR"
