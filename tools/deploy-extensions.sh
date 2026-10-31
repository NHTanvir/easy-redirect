#!/usr/bin/env bash
# Build and publish Easy Redirect and Roadmap Coach for Chrome's force-install
# policy (ExtensionInstallForcelist, see tools/force-install-policy.json).
#
# For each extension: copy the repo to a staging folder, bump the version so
# Chrome sees an update, point update_url at the local update server, pack and
# sign it with its key, and publish the .crx plus updates.xml in $WWW. The
# local server (tools/focus-extensions-server.service) serves $WWW on
# 127.0.0.1:$PORT. Chrome checks for updates every few hours; to update now,
# restart Chrome.
#
# Keys live outside the repos in $KEYS and must never be committed.
set -euo pipefail

WWW="${FOCUS_WWW:-$HOME/.local/share/focus-extensions/www}"
KEYS="${FOCUS_KEYS:-$HOME/.config/focus-extensions/keys}"
STATE_DIR="${FOCUS_STATE:-$HOME/.local/share/focus-extensions}"
PORT="${FOCUS_PORT:-8787}"
BASE_URL="http://127.0.0.1:$PORT"
ROADMAP_README="${ROADMAP_README:-$HOME/Desktop/roadmap/README.md}"
CHROME="${CHROME:-google-chrome}"
# name:repo-path
EXTENSIONS=("easy-redirect:$HOME/Desktop/easy-redirect" "roadmap-coach:$HOME/Desktop/roadmap-coach")

mkdir -p "$WWW/roadmap" "$STATE_DIR"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# One build number for every deploy, so versions only ever go up.
BUILD_FILE="$STATE_DIR/build-number"
BUILD=$(( $(cat "$BUILD_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$BUILD" > "$BUILD_FILE"

APPS=""
for entry in "${EXTENSIONS[@]}"; do
    name="${entry%%:*}"; repo="${entry#*:}"
    key="$KEYS/$name.pem"
    [ -f "$key" ] || { echo "Missing key $key" >&2; exit 1; }
    [ -f "$repo/manifest.json" ] || { echo "No manifest in $repo" >&2; exit 1; }

    mkdir -p "$STAGE/$name"
    tar -C "$repo" --exclude=.git --exclude=tools -cf - . | tar -C "$STAGE/$name" -xf -

    # version = manifest version + build number; update_url = local server.
    version=$(python3 - "$STAGE/$name/manifest.json" "$BUILD" "$BASE_URL/updates.xml" <<'PY'
import json, sys
path, build, update_url = sys.argv[1], sys.argv[2], sys.argv[3]
m = json.load(open(path))
parts = m["version"].split(".")[:3]
m["version"] = ".".join(parts + [build])
m["update_url"] = update_url
json.dump(m, open(path, "w"), indent=2, ensure_ascii=False)
print(m["version"])
PY
)

    "$CHROME" --headless=new --user-data-dir="$STAGE/chrome-$name" --no-message-box \
        --pack-extension="$STAGE/$name" --pack-extension-key="$key" >/dev/null 2>&1
    [ -f "$STAGE/$name.crx" ] || { echo "Packing $name failed" >&2; exit 1; }
    cp "$STAGE/$name.crx" "$WWW/$name.crx"

    id=$(cat "$KEYS/$name.id")
    APPS="$APPS  <app appid='$id'>
    <updatecheck codebase='$BASE_URL/$name.crx' version='$version' />
  </app>
"
    echo "Built $name $version ($id)"
done

cat > "$WWW/updates.xml" <<XML
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
$APPS</gupdate>
XML

# Roadmap Coach can read the roadmap over HTTP, so it doesn't depend on
# file-URL access (which a force-installed extension may not get).
ln -sfn "$ROADMAP_README" "$WWW/roadmap/README.md"

echo "Published to $WWW (served on $BASE_URL)."
