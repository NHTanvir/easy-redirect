#!/usr/bin/env bash
# One-time move of the extensions' stored data (rules, settings, stats,
# roadmap progress) from the old path-based unpacked IDs to the fixed IDs
# from the manifest keys. Chrome must be closed. Existing data under the new
# IDs is backed up first; nothing under the old IDs is deleted.
set -euo pipefail

PROFILE="${CHROME_PROFILE:-$HOME/.config/google-chrome/Default}"
BACKUP="$HOME/.local/share/focus-extensions/storage-backup-$(date +%Y%m%d-%H%M%S)"
# old-id:new-id
MOVES=(
    "neacngkephdjgcjjendbnaiacejoflej:mmojifignfdbfkcacbcfbflnkfdcgood"   # Easy Redirect
    "nebknlihiblchhknlfcijcmoggjjofjg:ndhomdedcmiobobjnaeeiffflebkbiif"   # Roadmap Coach
)
STORES=("Local Extension Settings" "Sync Extension Settings")

if pgrep -x chrome >/dev/null; then
    echo "Chrome is running. Close it completely (all windows) and run this again." >&2
    exit 1
fi

mkdir -p "$BACKUP"
for move in "${MOVES[@]}"; do
    old="${move%%:*}"; new="${move#*:}"
    for store in "${STORES[@]}"; do
        src="$PROFILE/$store/$old"; dst="$PROFILE/$store/$new"
        [ -d "$src" ] || continue
        mkdir -p "$BACKUP/$store"
        cp -a "$src" "$BACKUP/$store/$old"
        if [ -d "$dst" ]; then
            cp -a "$dst" "$BACKUP/$store/$new"
            rm -rf "$dst"
        fi
        cp -a "$src" "$dst"
        echo "Copied $store: $old -> $new"
    done
done
echo "Backup of everything touched: $BACKUP"
