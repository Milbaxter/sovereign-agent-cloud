#!/bin/bash
# Schedule daily on the control host; upload only the encrypted result to Finnish storage.
set -euo pipefail
umask 077
: "${BACKUP_AGE_RECIPIENT:?Set operator public age recipient}"
destination=${1:?Pass a private encrypted-backup output path}
docker compose exec -T postgres pg_dump -U sovereign -d sovereign -Fc | age -r "$BACKUP_AGE_RECIPIENT" -o "$destination"
test -s "$destination"
echo 'Encrypted database backup written. Store signing/encryption keys separately.'
