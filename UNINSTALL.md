# Undo the force-install

Easy Redirect and Roadmap Coach are force-installed by Chrome policy, so they can't be disabled or removed from inside Chrome. This file is how to undo that. Everything here runs in a normal terminal.

| What | Where |
|---|---|
| Force-install policy | `/etc/opt/chrome/policies/managed/force-install.json` |
| No Incognito / Guest / new profiles policy | `/etc/opt/chrome/policies/managed/focus.json` |
| Local update server (user service) | `~/.config/systemd/user/focus-extensions-server.service` |
| Built packages | `~/.local/share/focus-extensions/www/` |
| Signing keys (keep them!) | `~/.config/focus-extensions/keys/` |
| Extension IDs | Easy Redirect `mmojifignfdbfkcacbcfbflnkfdcgood`, Roadmap Coach `ndhomdedcmiobobjnaeeiffflebkbiif` |

## 1. Back up your data first

When the policy is removed, Chrome **uninstalls** both extensions and **deletes their data** (rules, settings, stats, roadmap progress). Back it up while Chrome is closed:

```
pkill chrome   # or close every Chrome window
B=~/focus-extensions-backup-$(date +%Y%m%d-%H%M%S); mkdir -p "$B"
P=~/.config/google-chrome/Default
for id in mmojifignfdbfkcacbcfbflnkfdcgood ndhomdedcmiobobjnaeeiffflebkbiif; do
  for d in "Local Extension Settings" "Sync Extension Settings"; do
    [ -d "$P/$d/$id" ] && mkdir -p "$B/$d" && cp -a "$P/$d/$id" "$B/$d/"
  done
done
echo "Backup: $B"
```

Optional extra: in Easy Redirect → Rules tab → **Import / Export** → export a backup file.

## 2. Remove the force-install policy

```
sudo rm /etc/opt/chrome/policies/managed/force-install.json
```

To also allow Incognito, Guest windows and new profiles again:

```
sudo rm /etc/opt/chrome/policies/managed/focus.json
```

Restart Chrome. Check `chrome://policy`: the removed policies are gone. The two extensions are removed from Chrome.

## 3. Stop the local update server

```
systemctl --user disable --now focus-extensions-server
rm ~/.config/systemd/user/focus-extensions-server.service
systemctl --user daemon-reload
```

Optional: `rm -rf ~/.local/share/focus-extensions/www` (built packages). Keep `~/.config/focus-extensions/keys/` — without the keys the extensions get different IDs and lose their data.

## 4. (Optional) Keep using them without force-install

1. `chrome://extensions` → **Developer mode** on → **Load unpacked** → `~/Desktop/easy-redirect`, then again for `~/Desktop/roadmap-coach`. The manifest `key` gives them the same IDs as before.
2. Restore your data: close Chrome, then

```
B=~/focus-extensions-backup-XXXXXXXX-XXXXXX   # the folder from step 1
P=~/.config/google-chrome/Default
for d in "Local Extension Settings" "Sync Extension Settings"; do
  [ -d "$B/$d" ] && cp -a "$B/$d/." "$P/$d/"
done
```

3. Open Chrome. Roadmap Coach needs **Allow access to file URLs** (Details on its card) to read the README from disk, since the update server is gone.

## Redo the force-install later

See Easy Redirect's `CLAUDE.md` → **Force-install**: run `tools/deploy-extensions.sh`, install and start `tools/focus-extensions-server.service`, then `sudo cp tools/force-install-policy.json /etc/opt/chrome/policies/managed/force-install.json` and restart Chrome.
