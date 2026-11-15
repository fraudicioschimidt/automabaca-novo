#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[ "$(id -u)" = 0 ] || { echo 'Execute como root.' >&2; exit 1; }
command -v age >/dev/null
[ -s /etc/automabaca-novo/backup-recipient.txt ]
install -d -o root -g root -m 700 /var/log/automabaca-novo/archive /var/log/automabaca-novo/archive/bundles
install -d -o root -g root -m 755 /usr/local/lib/automabaca-novo/observability /var/lib/automabaca-novo/observability
install -d -o root -g deploy -m 750 /srv/apps/automabaca-novo/exports/logs /srv/apps/automabaca-novo/exports/log-tools
install -d -o deploy -g deploy -m 700 /var/lib/automabaca-novo/observability-receipts
# The existing parent belongs to ubuntu. Allow the SSH user to traverse it,
# without listing it or granting access to any sibling's contents.
setfacl -m u:deploy:--x /var/lib/automabaca-novo
for file in archive_common.py archive_sanitize.py collect.py export.py watchdog.py acknowledge-gap.py; do
  install -o root -g root -m 644 "$source_dir/$file" "/usr/local/lib/automabaca-novo/observability/$file"
done
for file in install-windows.ps1 sync-windows.ps1 windows-launcher.cs; do
  install -o root -g deploy -m 640 "$source_dir/$file" "/srv/apps/automabaca-novo/exports/log-tools/$file"
done
sha256sum "$source_dir/sync-windows.ps1" | cut -d ' ' -f1 > /srv/apps/automabaca-novo/exports/log-tools/sync-windows.sha256
chown root:deploy /srv/apps/automabaca-novo/exports/log-tools/sync-windows.sha256
chmod 640 /srv/apps/automabaca-novo/exports/log-tools/sync-windows.sha256
sha256sum "$source_dir/windows-launcher.cs" | cut -d ' ' -f1 > /srv/apps/automabaca-novo/exports/log-tools/windows-launcher.sha256
chown root:deploy /srv/apps/automabaca-novo/exports/log-tools/windows-launcher.sha256
chmod 640 /srv/apps/automabaca-novo/exports/log-tools/windows-launcher.sha256
for unit in collect export watchdog; do
  install -o root -g root -m 644 "$source_dir/automabaca-log-$unit.service" /etc/systemd/system/
  install -o root -g root -m 644 "$source_dir/automabaca-log-$unit.timer" /etc/systemd/system/
done
systemctl daemon-reload
systemctl enable --now automabaca-log-collect.timer automabaca-log-export.timer automabaca-log-watchdog.timer
systemctl start automabaca-log-collect.service
systemctl start automabaca-log-export.service
systemctl start automabaca-log-watchdog.service
