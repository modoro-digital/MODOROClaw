#!/bin/bash
# MODOROClaw — Mac full reset (equivalent of RESET.bat)
# Wipes all runtime state so next launch is exactly like a fresh install.

set -u

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Auto-recover: if source missing here but a child folder (claw/, etc.)
# contains it, cd into that. Same logic as RUN.command.
if [ ! -f "$SCRIPT_DIR/electron/main.js" ]; then
  for child in claw modoroclaw modoro-claw MODOROClaw; do
    if [ -f "$SCRIPT_DIR/$child/electron/main.js" ]; then
      echo "  ℹ Tìm thấy source trong subfolder: $child/ — chuyển vào đó"
      SCRIPT_DIR="$SCRIPT_DIR/$child"
      cd "$SCRIPT_DIR"
      break
    fi
  done
fi

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║    MODOROClaw — FULL RESET            ║"
echo "  ║    (mo phong may hoan toan moi)       ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

# 1. Stop any running gateway / electron / openzca / 9router
echo "  Dang gateway + processes..."
command -v openclaw &> /dev/null && openclaw gateway stop 2>/dev/null || true
pkill -f "Electron" 2>/dev/null || true
pkill -f "MODOROClaw" 2>/dev/null || true
pkill -f "openclaw.mjs" 2>/dev/null || true
pkill -f "openzca" 2>/dev/null || true
pkill -f "9router" 2>/dev/null || true
sleep 2

# 2. Uninstall global npm packages.
# Use a fresh PATH so we can find npm regardless of how user installed Node
# (Homebrew, nvm, volta, etc.) — same enumeration logic as RUN.command.
PATH_EXTRA="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/opt/local/bin:/opt/local/sbin:$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.volta/bin:$HOME/.asdf/shims:$HOME/.local/share/mise/shims:$HOME/.nodenv/shims"
if [ -d "$HOME/.nvm/versions/node" ]; then
  NVM_LATEST="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -rV | head -1)"
  [ -n "$NVM_LATEST" ] && PATH_EXTRA="$PATH_EXTRA:$HOME/.nvm/versions/node/$NVM_LATEST/bin"
fi
export PATH="$PATH_EXTRA:$PATH"

# Detect npm prefix to know if we need sudo. If npm prefix is owned by root
# (the case when Node was installed via the official .pkg installer from
# nodejs.org), npm install/uninstall -g requires sudo.
NEED_SUDO_FOR_NPM=0
if command -v npm >/dev/null 2>&1; then
  NPM_PREFIX="$(npm config get prefix 2>/dev/null)"
  if [ -n "$NPM_PREFIX" ] && [ -d "$NPM_PREFIX" ]; then
    if [ ! -w "$NPM_PREFIX" ] || [ ! -w "$NPM_PREFIX/lib/node_modules" ] 2>/dev/null; then
      NEED_SUDO_FOR_NPM=1
    fi
  fi
fi

# Helper: run a command, automatically prepending sudo if NEED_SUDO_FOR_NPM=1.
# We use `sudo -p "..."` to give a clear prompt explaining WHY sudo is needed.
sudo_npm() {
  if [ "$NEED_SUDO_FOR_NPM" = "1" ]; then
    sudo -p "  → Cần sudo để gỡ npm globals (Node cài qua .pkg → /usr/local). Nhập password Mac: " "$@"
  else
    "$@"
  fi
}

echo "  Xoa OpenClaw + 9Router + openzca (npm globals)..."
sudo_npm npm uninstall -g openclaw 2>/dev/null || true
sudo_npm npm uninstall -g 9router 2>/dev/null || true
sudo_npm npm uninstall -g openzca 2>/dev/null || true

# Belt-and-braces: also delete the bin shims directly in case the npm prefix
# isn't where we think it is. Covers Homebrew, system /usr/local, ~/.npm-global,
# nvm, volta, asdf, and Apple Silicon /opt/homebrew layouts.
#
# Each rm gets sudo if the parent dir isn't writable by the current user.
remove_path() {
  local target="$1"
  [ -e "$target" ] || return 0
  if rm -rf "$target" 2>/dev/null; then
    return 0
  fi
  # Permission denied — retry with sudo
  sudo -p "  → Cần sudo để xóa $target: " rm -rf "$target" 2>/dev/null || true
}

for prefix in /opt/homebrew /usr/local /opt/local "$HOME/.npm-global" "$HOME/.local"; do
  for name in openclaw 9router openzca; do
    remove_path "$prefix/bin/$name"
  done
  for name in openclaw 9router openzca; do
    remove_path "$prefix/lib/node_modules/$name"
  done
done
# nvm bin shims (per-version)
if [ -d "$HOME/.nvm/versions/node" ]; then
  for v in "$HOME/.nvm/versions/node"/*; do
    [ -d "$v" ] || continue
    for name in openclaw 9router openzca; do
      rm -f "$v/bin/$name" 2>/dev/null || true
      rm -rf "$v/lib/node_modules/$name" 2>/dev/null || true
    done
  done
fi

# 3. Wipe OpenClaw config + data
echo "  Xoa OpenClaw config + data..."
rm -rf "$HOME/.openclaw"

# 4. Wipe 9Router config (Mac path)
echo "  Xoa 9Router config..."
rm -rf "$HOME/Library/Application Support/9router"
rm -rf "$HOME/.9router"

# 5. Wipe Zalo session (openzca profiles)
echo "  Xoa Zalo session..."
rm -rf "$HOME/.openzca"

# 6. Wipe app userData (packaged Electron writes here)
echo "  Xoa MODOROClaw userData..."
rm -rf "$HOME/Library/Application Support/MODOROClaw"
rm -rf "$HOME/Library/Application Support/modoro-claw"
rm -rf "$HOME/Library/Logs/MODOROClaw"
rm -rf "$HOME/Library/Logs/modoro-claw"
rm -rf "$HOME/Library/Caches/vn.modoro.claw"
rm -rf "$HOME/Library/Preferences/vn.modoro.claw.plist"

# 7. Wipe app logs (dev)
echo "  Xoa logs..."
rm -rf "$SCRIPT_DIR/logs"
rm -rf "$SCRIPT_DIR/electron/logs"

# 8. Wipe runtime files in workspace (dev mode) — seedWorkspace() will recreate
echo "  Xoa runtime files (schedules.json, custom-crons.json, zalo-blocklist.json)..."
rm -f "$SCRIPT_DIR/schedules.json"
rm -f "$SCRIPT_DIR/custom-crons.json"
rm -f "$SCRIPT_DIR/zalo-blocklist.json"

# 8b. Wipe cron telemetry + sticky chatId (recreated on next boot/cron)
echo "  Xoa cron telemetry + sticky chatId..."
rm -f "$SCRIPT_DIR/logs/cron-runs.jsonl"
rm -f "$SCRIPT_DIR/logs/boot-diagnostic.txt"
rm -f "$SCRIPT_DIR/logs/cron-cannot-deliver.txt"
rm -f "$HOME/.openclaw/modoroclaw-sticky-chatid.json"

# 9. Wipe daily memory + heartbeat state
echo "  Xoa daily memory + sessions..."
find "$SCRIPT_DIR/memory" -name "20*.md" -type f -delete 2>/dev/null || true
rm -f "$SCRIPT_DIR/memory/heartbeat-state.json"

# 10. Wipe personalized active.md (wizard recreates)
echo "  Xoa personalization (active.md)..."
rm -f "$SCRIPT_DIR/skills/active.md"
rm -f "$SCRIPT_DIR/industry/active.md"
rm -f "$SCRIPT_DIR/prompts/sop/active.md"
rm -f "$SCRIPT_DIR/prompts/training/active.md"

# 11. Wipe runtime config
rm -f "$SCRIPT_DIR/config/zalo-mode.txt"

# 12. Wipe Knowledge tab DB + uploaded files (re-seeded by seedWorkspace)
echo "  Xoa Knowledge DB + uploaded files..."
rm -f "$SCRIPT_DIR/memory.db"
rm -rf "$SCRIPT_DIR/knowledge/cong-ty/files"
rm -rf "$SCRIPT_DIR/knowledge/san-pham/files"
rm -rf "$SCRIPT_DIR/knowledge/nhan-vien/files"
rm -f "$SCRIPT_DIR/knowledge/cong-ty/index.md"
rm -f "$SCRIPT_DIR/knowledge/san-pham/index.md"
rm -f "$SCRIPT_DIR/knowledge/nhan-vien/index.md"

# 13. Wipe better-sqlite3 build (postinstall regenerates for current Electron ABI)
echo "  Xoa better-sqlite3 binary..."
rm -rf "$SCRIPT_DIR/electron/node_modules/better-sqlite3/build"

# 14. Re-run npm install in electron/ to fire postinstall
if [ -d "$SCRIPT_DIR/electron/node_modules" ]; then
    echo "  Re-run npm install in electron/..."
    pushd "$SCRIPT_DIR/electron" > /dev/null
    npm install --silent 2>/dev/null || true
    popd > /dev/null
fi

echo ""
echo "  ✅ Done! May sach nhu moi."
echo "  Chay ./RUN.command de test tu dau."
echo ""
read -p "Press enter to close..."
