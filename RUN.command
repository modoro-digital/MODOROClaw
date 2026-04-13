#!/bin/bash
#
# MODOROClaw — Mac installer + launcher (one file)
# =====================================================
# Lần đầu chạy:
#   1. Mở Terminal, cd vào thư mục claw
#   2. chmod +x RUN.command RESET.command
#   3. Double-click RUN.command từ Finder, hoặc ./RUN.command
#
# Nếu macOS chặn vì "unidentified developer":
#   - Right-click RUN.command → Open → Open
#   - Hoặc: System Settings → Privacy & Security → Allow
#
# File này tự làm hết:
#   - Tìm Node.js trên mọi vị trí (Homebrew, nvm, volta, asdf, fnm, system)
#   - Nếu thiếu Node, hỏi user có muốn cài qua Homebrew không
#   - Tự npm install -g openclaw + 9router nếu chưa có
#   - npm install electron deps
#   - Pre-warm 9router + openclaw gateway
#   - Launch Electron app
#   - Khi đóng app: hiện log + boot-diagnostic.txt để debug
#
# Đây là cách cài "bình thường" mà user Mac nào cũng dùng:
# Homebrew → Node → npm install -g → npm install (electron deps).

set -e
# pipefail is REQUIRED — without it `cmd | tee log` returns tee's exit code,
# masking npm install failures and making the script claim "OK" after errors.
set -o pipefail

# Resolve script dir even when launched via Finder (cwd defaults to $HOME)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo ""
echo "  ╔═══════════════════════════════════════════╗"
echo "  ║   🦞  MODOROClaw — macOS installer/run    ║"
echo "  ╚═══════════════════════════════════════════╝"
echo ""

# ----------------------------------------------------------------------
# STEP 0 — Sanity check: source tree must be complete.
#
# If user only downloaded RUN.command alone (e.g. saved a single file from
# Telegram instead of the full ZIP), we'd fail later with cryptic errors
# like "cd: ./electron: No such file or directory". Detect that NOW and
# give clear instructions.
# ----------------------------------------------------------------------
MISSING_FILES=""
[ -f "$SCRIPT_DIR/electron/main.js" ] || MISSING_FILES="$MISSING_FILES electron/main.js"
[ -f "$SCRIPT_DIR/electron/package.json" ] || MISSING_FILES="$MISSING_FILES electron/package.json"
[ -f "$SCRIPT_DIR/AGENTS.md" ] || MISSING_FILES="$MISSING_FILES AGENTS.md"

# Auto-recover: if source missing here BUT a child folder (claw/, modoroclaw/,
# etc.) contains the source, transparently cd into it. Common case: user
# extracted ZIP at parent level and double-clicked the parent's RUN.command
# (or symlink) instead of the one inside the extracted folder.
if [ -n "$MISSING_FILES" ]; then
  for child in claw modoroclaw modoro-claw MODOROClaw; do
    if [ -f "$SCRIPT_DIR/$child/electron/main.js" ] && \
       [ -f "$SCRIPT_DIR/$child/electron/package.json" ] && \
       [ -f "$SCRIPT_DIR/$child/AGENTS.md" ]; then
      echo "  ℹ Tìm thấy source trong subfolder: $child/"
      echo "  → Tự chuyển vào $SCRIPT_DIR/$child"
      echo ""
      SCRIPT_DIR="$SCRIPT_DIR/$child"
      cd "$SCRIPT_DIR"
      MISSING_FILES=""
      break
    fi
  done
fi

if [ -n "$MISSING_FILES" ]; then
  echo "  ✗ THIẾU SOURCE CODE — không thể chạy."
  echo ""
  echo "  Folder hiện tại ($SCRIPT_DIR) chỉ có RUN.command nhưng KHÔNG"
  echo "  có các file source cần thiết:"
  for f in $MISSING_FILES; do echo "    - $f"; done
  echo ""
  echo "  NGUYÊN NHÂN: bạn chỉ có file RUN.command đơn lẻ, không có toàn bộ folder claw/."
  echo ""
  echo "  CÁCH FIX:"
  echo "    1. Liên hệ Modoro để xin file modoroclaw-mac.zip (khoảng 675 KB)"
  echo "    2. Tải file ZIP về Mac"
  echo "    3. Double-click file ZIP → Mac tự giải nén thành folder \"claw\""
  echo "    4. Kéo CẢ folder claw/ (không phải từng file) vào Documents/Desktop"
  echo "    5. Trong folder claw/ đã giải nén, double-click RUN.command từ đó"
  echo ""
  echo "  Nội dung folder hiện tại:"
  ls -la "$SCRIPT_DIR" 2>/dev/null | tail -n +2 | head -10 | sed 's/^/    /'
  echo ""
  read -p "  Nhấn Enter để đóng..."
  exit 1
fi

# ----------------------------------------------------------------------
# STEP 1 — Augment PATH for Finder-launched apps.
#
# When you double-click a .command file from Finder, the shell that runs
# it inherits a minimal PATH (no shell rc files run). That means nvm,
# volta, asdf, fnm, and even Homebrew on Apple Silicon may be missing.
# Add every common Node/npm install location explicitly so `node`,
# `openclaw`, `npm`, `brew` resolve regardless of how they were installed.
# ----------------------------------------------------------------------
PATH_EXTRA="/opt/homebrew/bin:/opt/homebrew/sbin"
PATH_EXTRA="$PATH_EXTRA:/usr/local/bin:/usr/local/sbin"
PATH_EXTRA="$PATH_EXTRA:/opt/local/bin:/opt/local/sbin"
PATH_EXTRA="$PATH_EXTRA:$HOME/.npm-global/bin"
PATH_EXTRA="$PATH_EXTRA:$HOME/.local/bin"
PATH_EXTRA="$PATH_EXTRA:$HOME/.volta/bin"
PATH_EXTRA="$PATH_EXTRA:$HOME/.asdf/shims"
PATH_EXTRA="$PATH_EXTRA:$HOME/.local/share/mise/shims"
PATH_EXTRA="$PATH_EXTRA:$HOME/.nodenv/shims"
# nvm: pick the highest version installed (if any)
if [ -d "$HOME/.nvm/versions/node" ]; then
  NVM_LATEST="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -rV | head -1)"
  if [ -n "$NVM_LATEST" ]; then
    PATH_EXTRA="$PATH_EXTRA:$HOME/.nvm/versions/node/$NVM_LATEST/bin"
  fi
fi
# fnm: pick the highest version
if [ -d "$HOME/.local/share/fnm/node-versions" ]; then
  FNM_LATEST="$(ls -1 "$HOME/.local/share/fnm/node-versions" 2>/dev/null | sort -rV | head -1)"
  if [ -n "$FNM_LATEST" ]; then
    PATH_EXTRA="$PATH_EXTRA:$HOME/.local/share/fnm/node-versions/$FNM_LATEST/installation/bin"
  fi
fi
export PATH="$PATH_EXTRA:$PATH"

# ----------------------------------------------------------------------
# STEP 2 — Make sure Node.js is installed
# ----------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "  ⚠  Node.js chưa cài đặt trên máy này."
  echo ""
  echo "  Có 2 cách cài:"
  echo "    1. Homebrew (khuyến nghị)  — script này sẽ tự làm"
  echo "    2. Tải installer thủ công từ https://nodejs.org"
  echo ""
  read -p "  Cài Node.js qua Homebrew ngay bây giờ? [y/N]: " yn
  case "$yn" in
    [Yy]* )
      if ! command -v brew >/dev/null 2>&1; then
        echo ""
        echo "  Cài Homebrew trước (có thể yêu cầu password Mac)..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || {
          echo ""
          echo "  ✗ Cài Homebrew thất bại. Cài thủ công tại https://brew.sh rồi chạy lại RUN.command."
          read -p "  Nhấn Enter để đóng..."
          exit 1
        }
        # Refresh PATH for the new Homebrew
        if [ -x /opt/homebrew/bin/brew ]; then
          eval "$(/opt/homebrew/bin/brew shellenv)"
        elif [ -x /usr/local/bin/brew ]; then
          eval "$(/usr/local/bin/brew shellenv)"
        fi
      fi
      echo ""
      echo "  Cài Node.js (LTS) qua Homebrew..."
      brew install node || {
        echo "  ✗ Cài Node thất bại. Thử: brew install node@22"
        read -p "  Nhấn Enter để đóng..."
        exit 1
      }
      ;;
    * )
      echo ""
      echo "  ✗ Cần Node.js để chạy. Tải tại https://nodejs.org rồi chạy lại RUN.command."
      read -p "  Nhấn Enter để đóng..."
      exit 1
      ;;
  esac
fi

# Verify Node version (must be >= 22 — openzca builds with --target node22 và yêu cầu 22.13+)
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  echo "  ⚠  Node.js phiên bản quá cũ ($(node -v)). Cần Node 22.13+ (openzca/Zalo plugin yêu cầu)."
  echo "     Cập nhật: brew install node@22  hoặc  https://nodejs.org"
  echo ""
  read -p "  Tiếp tục với Node cũ? [y/N]: " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then exit 1; fi
fi
echo "  ✓ Node.js: $(node -v) ($(command -v node))"

# Detect whether npm prefix needs sudo. The official Node .pkg installer puts
# npm at /usr/local which is root-owned — every npm install -g would otherwise
# fail with "EACCES: permission denied". Detect this and auto-prepend sudo.
NEED_SUDO_FOR_NPM=0
NPM_PREFIX="$(npm config get prefix 2>/dev/null)"
if [ -n "$NPM_PREFIX" ] && [ -d "$NPM_PREFIX" ]; then
  if [ ! -w "$NPM_PREFIX/lib/node_modules" ] 2>/dev/null && [ ! -w "$NPM_PREFIX" ]; then
    NEED_SUDO_FOR_NPM=1
  fi
fi
if [ "$NEED_SUDO_FOR_NPM" = "1" ]; then
  echo "  ℹ  npm prefix ($NPM_PREFIX) là root-owned (Node cài qua .pkg)."
  echo "     Khi cài openclaw/9router sẽ cần sudo — Mac sẽ hỏi password."
fi

# Detect + auto-fix the OTHER common npm permission problem: ~/.npm/_cacache/
# owned by root (happens when user previously ran `sudo npm install` somewhere).
# Symptom: `EACCES: permission denied, mkdir '/Users/<u>/.npm/_cacache/...'`.
# Fix: chown the entire ~/.npm tree back to the current user.
fix_npm_cache_perms_if_needed() {
  if [ ! -d "$HOME/.npm" ]; then return 0; fi
  # Check ownership — if any non-current-user owns ~/.npm/_cacache, we need to chown
  local current_user
  current_user="$(whoami)"
  local cache_owner
  cache_owner="$(stat -f '%Su' "$HOME/.npm" 2>/dev/null || echo "")"
  if [ -n "$cache_owner" ] && [ "$cache_owner" != "$current_user" ]; then
    echo "  ⚠  ~/.npm thuộc quyền '$cache_owner' (không phải '$current_user') — fix bằng sudo chown..."
    sudo -p "  → Nhập password Mac để fix npm cache ownership: " chown -R "$current_user" "$HOME/.npm" 2>/dev/null || {
      echo "  ✗ Không chown được — chạy tay: sudo chown -R \$(whoami) ~/.npm"
      return 1
    }
    echo "  ✓ npm cache ownership đã fix"
  fi
  return 0
}

# Run npm install -g for one package, with smart error recovery:
#   1. First attempt — direct, possibly with sudo if NEED_SUDO_FOR_NPM=1.
#   2. If output contains the cache-perm error → auto-chown ~/.npm + retry.
#   3. If still fails → return non-zero so caller can show its own error.
npm_install_global() {
  local pkg="$1"
  local tmp_log="/tmp/modoroclaw-npm-$$.log"
  local cmd_prefix=""
  if [ "$NEED_SUDO_FOR_NPM" = "1" ]; then
    cmd_prefix="sudo -p   →   Nhập   password   Mac   để   cài   $pkg   vào   $NPM_PREFIX:_"
  fi

  # CRITICAL: when sudo runs npm, npm inherits caller's $HOME → it writes to
  # /Users/<u>/.npm/_cacache as ROOT, poisoning the user cache for all later
  # non-sudo npm calls (e.g. `npm install` in electron/). To prevent this we
  # ALWAYS pass --cache=/tmp/modoroclaw-npm-cache for sudo invocations so the
  # user's ~/.npm stays untouched.
  local SUDO_CACHE_FLAG="--cache=/tmp/modoroclaw-npm-cache"

  # Attempt 1
  if [ "$NEED_SUDO_FOR_NPM" = "1" ]; then
    if sudo -p "  → Nhập password Mac để cài $pkg vào $NPM_PREFIX: " npm install -g "$pkg" $SUDO_CACHE_FLAG 2>&1 | tee "$tmp_log"; then
      rm -f "$tmp_log"
      return 0
    fi
  else
    if npm install -g "$pkg" 2>&1 | tee "$tmp_log"; then
      rm -f "$tmp_log"
      return 0
    fi
  fi

  # Attempt 2 — recover from common errors
  if grep -qE "EACCES.*\.npm/_cacache|Invalid response body.*EACCES" "$tmp_log"; then
    echo ""
    echo "  ⚠  Phát hiện lỗi npm cache permission. Đang tự fix..."
    if fix_npm_cache_perms_if_needed; then
      echo "  Thử cài lại $pkg..."
      if [ "$NEED_SUDO_FOR_NPM" = "1" ]; then
        sudo -p "  → Nhập password Mac (lần 2): " npm install -g "$pkg" $SUDO_CACHE_FLAG 2>&1 | tee "$tmp_log" && { rm -f "$tmp_log"; return 0; }
      else
        npm install -g "$pkg" 2>&1 | tee "$tmp_log" && { rm -f "$tmp_log"; return 0; }
      fi
    fi
  fi

  # Attempt 3 — corrupt cache: bypass user cache entirely
  if grep -qE "EEXIST|EACCES" "$tmp_log"; then
    echo ""
    echo "  ⚠  npm cache có vẻ corrupt. Thử cài với cache tạm..."
    if [ "$NEED_SUDO_FOR_NPM" = "1" ]; then
      sudo -p "  → Password Mac (lần 3): " npm install -g "$pkg" --cache=/tmp/modoroclaw-npm-cache 2>&1 | tee "$tmp_log" && { rm -f "$tmp_log"; return 0; }
    else
      npm install -g "$pkg" --cache=/tmp/modoroclaw-npm-cache 2>&1 | tee "$tmp_log" && { rm -f "$tmp_log"; return 0; }
    fi
  fi

  rm -f "$tmp_log"
  return 1
}

# ----------------------------------------------------------------------
# STEP 3 — Install pinned versions of openclaw + 9router + openzca
# ----------------------------------------------------------------------
# CRITICAL: Pin EXACT versions to protect against upstream schema breakage.
# Single source of truth is electron/scripts/prebuild-vendor.js. Keep these
# in sync. To upgrade: edit both, smoke-test, then ship a new build.
MODORO_OPENCLAW_VERSION="2026.4.5"
MODORO_9ROUTER_VERSION="0.3.82"
MODORO_OPENZCA_VERSION="0.1.57"

if ! command -v openclaw >/dev/null 2>&1; then
  echo ""
  echo "  Cài openclaw@${MODORO_OPENCLAW_VERSION} (pinned version)..."
  if ! npm_install_global "openclaw@${MODORO_OPENCLAW_VERSION}"; then
    echo ""
    echo "  ✗ Cài openclaw thất bại sau 3 lần thử. Có thể là một trong các nguyên nhân sau:"
    echo ""
    echo "  1. npm cache vẫn có vấn đề về quyền — chạy tay:"
    echo "       sudo chown -R \$(whoami) ~/.npm"
    echo "       rm -rf ~/.npm/_cacache"
    echo ""
    echo "  2. npm prefix bị chiếm bởi root — đổi sang home directory:"
    echo "       mkdir -p ~/.npm-global"
    echo "       npm config set prefix '~/.npm-global'"
    echo "       echo 'export PATH=~/.npm-global/bin:\$PATH' >> ~/.zshrc"
    echo "       source ~/.zshrc"
    echo ""
    echo "  3. Mạng yếu / registry npm chậm — thử lại sau vài phút."
    echo ""
    echo "  Sau khi fix, chạy lại RUN.command."
    read -p "  Nhấn Enter để đóng..."
    exit 1
  fi
  # Refresh PATH in case openclaw landed in a new prefix
  hash -r 2>/dev/null || true
fi
echo "  ✓ openclaw: $(openclaw --version 2>/dev/null | head -1) ($(command -v openclaw))"

# ----------------------------------------------------------------------
# STEP 4 — Install 9router globally if missing (non-fatal)
# ----------------------------------------------------------------------
if ! command -v 9router >/dev/null 2>&1; then
  echo ""
  echo "  Cài 9router@${MODORO_9ROUTER_VERSION} (pinned version)..."
  if ! npm_install_global "9router@${MODORO_9ROUTER_VERSION}"; then
    echo "  ⚠  Cài 9router thất bại — không nghiêm trọng. Tab 9Router trong app sẽ trống nhưng cron + bot vẫn chạy bình thường."
  fi
fi
if command -v 9router >/dev/null 2>&1; then
  echo "  ✓ 9router: $(command -v 9router)"
fi

# ----------------------------------------------------------------------
# STEP 4B — Install openzca globally if missing (REQUIRED for Zalo listener)
# ----------------------------------------------------------------------
# Critical: Without openzca, openzalo plugin cannot spawn the Zalo websocket
# listener → "Chưa sẵn sàng" forever. The gateway does NOT auto-install
# openzca like it does openclaw, so we MUST do it here on first run.
if ! command -v openzca >/dev/null 2>&1; then
  # Also check via lib path in case PATH not updated yet
  OPENZCA_FOUND=""
  for prefix in /opt/homebrew /usr/local /opt/local "$HOME/.npm-global" "$HOME/.local"; do
    if [ -f "$prefix/lib/node_modules/openzca/dist/cli.js" ]; then
      OPENZCA_FOUND="$prefix"
      break
    fi
  done
  if [ -z "$OPENZCA_FOUND" ]; then
    echo ""
    echo "  Cài openzca@${MODORO_OPENZCA_VERSION} (pinned version) — cần cho Zalo listener..."
    if ! npm_install_global "openzca@${MODORO_OPENZCA_VERSION}"; then
      echo ""
      echo "  ✗ Cài openzca thất bại sau 3 lần thử. Zalo sẽ KHÔNG hoạt động."
      echo ""
      echo "  Recovery options:"
      echo "  1. Thử thủ công:"
      echo "       npm install -g openzca"
      echo "       (nếu fail với EACCES → 'sudo chown -R \$(whoami) ~/.npm' rồi thử lại)"
      echo ""
      echo "  2. Đổi npm prefix sang home directory:"
      echo "       mkdir -p ~/.npm-global"
      echo "       npm config set prefix '~/.npm-global'"
      echo "       npm install -g openzca"
      echo ""
      echo "  3. Tạm bỏ qua Zalo, dùng Telegram trước (cron + Telegram bot vẫn chạy)."
      echo ""
      echo "  App sẽ vẫn khởi động — chỉ Zalo bị thiếu."
      sleep 3  # Give user time to read
    fi
  fi
fi
if command -v openzca >/dev/null 2>&1; then
  echo "  ✓ openzca: $(command -v openzca)"
fi

# ----------------------------------------------------------------------
# STEP 5 — Install Electron app dependencies (one-time, ~3-5 min)
# ----------------------------------------------------------------------
cd "$SCRIPT_DIR/electron"
if [ ! -d "node_modules" ] || [ ! -d "node_modules/electron" ] || [ ! -f "node_modules/.bin/electron" ]; then
  echo ""
  echo "  📦 Cài dependencies cho Electron app (lần đầu, ~3-5 phút)..."
  # Heal npm cache perms first — earlier sudo npm calls (or any past
  # `sudo npm install` the user did) may have left ~/.npm root-owned, which
  # would make this non-sudo npm install fail with EACCES.
  fix_npm_cache_perms_if_needed || true

  # Helper: run npm install, capture log, return real npm exit code (NOT tee's).
  # Without pipefail this would silently succeed on tee even when npm fails.
  electron_npm_log="/tmp/modoroclaw-electron-npm-$$.log"
  run_electron_npm_install() {
    local extra=("$@")
    npm install "${extra[@]}" 2>&1 | tee "$electron_npm_log"
    return ${PIPESTATUS[0]}
  }

  attempt_ok=0

  # Attempt 1: plain npm install
  if run_electron_npm_install; then
    attempt_ok=1
  elif grep -qE "EACCES.*\.npm/_cacache|Invalid response body.*EACCES" "$electron_npm_log"; then
    echo ""
    echo "  ⚠  npm cache permission lỗi. Đang tự chown..."
    fix_npm_cache_perms_if_needed || true
    if run_electron_npm_install; then attempt_ok=1; fi
  fi

  # Attempt 2: cache corrupt (EEXIST) → nuke cache completely + retry
  if [ "$attempt_ok" = "0" ] && grep -qE "EEXIST" "$electron_npm_log"; then
    echo ""
    echo "  ⚠  npm cache có file corrupt (EEXIST). Đang xóa cache và thử lại..."
    if [ -d "$HOME/.npm/_cacache" ] && [ ! -w "$HOME/.npm/_cacache" ]; then
      sudo -p "  → Password Mac để xóa cache root-owned: " rm -rf "$HOME/.npm/_cacache" 2>/dev/null || rm -rf "$HOME/.npm/_cacache" 2>/dev/null || true
    else
      rm -rf "$HOME/.npm/_cacache" 2>/dev/null || true
    fi
    fix_npm_cache_perms_if_needed || true
    if run_electron_npm_install; then attempt_ok=1; fi
  fi

  # Attempt 3: bypass user cache entirely
  if [ "$attempt_ok" = "0" ]; then
    echo ""
    echo "  ⚠  Thử lần cuối với cache tạm /tmp..."
    rm -rf /tmp/modoroclaw-npm-cache 2>/dev/null || true
    if run_electron_npm_install --cache=/tmp/modoroclaw-npm-cache; then attempt_ok=1; fi
  fi

  if [ "$attempt_ok" = "0" ]; then
    rm -f "$electron_npm_log"
    echo ""
    echo "  ✗ npm install thất bại. Chạy tay từ Terminal:"
    echo "       sudo rm -rf ~/.npm/_cacache"
    echo "       sudo chown -R \$(whoami) ~/.npm"
    echo "       cd $SCRIPT_DIR/electron && npm install"
    echo "       cd .. && ./RUN.command"
    read -p "  Nhấn Enter để đóng..."
    exit 1
  fi
  rm -f "$electron_npm_log"
fi

# Hard verification — script's "OK" must match reality
if [ ! -f "$SCRIPT_DIR/electron/node_modules/.bin/electron" ]; then
  echo ""
  echo "  ✗ Electron binary KHÔNG tồn tại sau npm install — npm install thực sự đã fail."
  echo "  Chạy tay từ Terminal:"
  echo "       sudo rm -rf ~/.npm/_cacache"
  echo "       sudo chown -R \$(whoami) ~/.npm"
  echo "       cd $SCRIPT_DIR/electron && npm install"
  read -p "  Nhấn Enter để đóng..."
  exit 1
fi

# Safety net: better-sqlite3 ABI must match Electron's bundled Node
if [ -d "node_modules/better-sqlite3" ] && [ ! -f "node_modules/better-sqlite3/build/Release/better_sqlite3.node" ]; then
  echo "  Sửa better-sqlite3 ABI..."
  if [ -f "scripts/fix-better-sqlite3.js" ]; then
    node scripts/fix-better-sqlite3.js || true
  fi
fi
echo "  ✓ Electron deps: OK"

# ----------------------------------------------------------------------
# STEP 5B — Pre-build vendor/ for packaged .app (DEV ONLY — skipped if running unpacked)
# ----------------------------------------------------------------------
# When running RUN.command directly (dev mode), the .app isn't packaged yet
# so vendor/ isn't strictly needed. But we run prebuild-vendor anyway so the
# next `npm run build:mac` has up-to-date vendor/ + we can verify Node binary
# integrity NOW instead of finding out at build time. If prebuild fails or
# doesn't produce the expected node binary, warn loudly so dev sees it before
# shipping a broken .dmg.
if [ -f "scripts/prebuild-vendor.js" ]; then
  echo ""
  echo "  Chuẩn bị vendor/ (Node + openclaw + 9router + openzca cho .app)..."
  TARGET_PLATFORM=darwin node scripts/prebuild-vendor.js || {
    echo "  ⚠  prebuild-vendor.js exit non-zero — vendor/ có thể không đầy đủ. .dmg build sau sẽ fail."
  }
  if [ ! -f "vendor/node/bin/node" ]; then
    echo "  ⚠  CẢNH BÁO: vendor/node/bin/node KHÔNG tồn tại sau prebuild!"
    echo "      Packaged .app sẽ không có Node bundled. .dmg build sẽ fail hoặc app sẽ crash."
    echo "      Kiểm tra log prebuild-vendor ở trên."
  else
    echo "  ✓ vendor/node/bin/node: OK ($(./vendor/node/bin/node --version 2>/dev/null || echo 'unknown version'))"
  fi
  for pkg in openclaw 9router openzca; do
    if [ ! -d "vendor/node_modules/$pkg" ]; then
      echo "  ⚠  CẢNH BÁO: vendor/node_modules/$pkg thiếu — packaged .app sẽ không có $pkg!"
    fi
  done
fi

# ----------------------------------------------------------------------
# STEP 6 — Clean stale logs from previous run
# ----------------------------------------------------------------------
rm -f "$SCRIPT_DIR/logs/openclaw.log"

# ----------------------------------------------------------------------
# STEP 7 — Pre-warm 9router (background, hidden)
# ----------------------------------------------------------------------
if command -v 9router >/dev/null 2>&1; then
  if ! curl -fs http://127.0.0.1:20128 >/dev/null 2>&1; then
    nohup 9router -n --skip-update >/dev/null 2>&1 &
    disown 2>/dev/null || true
  fi
fi

# ----------------------------------------------------------------------
# STEP 8 — Pre-warm openclaw gateway (background, hidden)
# ----------------------------------------------------------------------
if command -v openclaw >/dev/null 2>&1; then
  if ! curl -fs http://127.0.0.1:18789 >/dev/null 2>&1; then
    nohup openclaw gateway run >/dev/null 2>&1 &
    disown 2>/dev/null || true
  fi
fi

# ----------------------------------------------------------------------
# STEP 9 — Launch Electron app (foreground, NOT exec — so we can tail
#          logs after the user closes the window)
# ----------------------------------------------------------------------
echo ""
echo "  🚀 Khởi động MODOROClaw..."
echo ""

./node_modules/.bin/electron . || true

# ----------------------------------------------------------------------
# STEP 10 — On exit, show recent log + boot diagnostic so user can debug
# ----------------------------------------------------------------------
echo ""
echo "  ╔═══════════════════════════════════════════╗"
echo "  ║         === MODOROClaw đã đóng ===        ║"
echo "  ╚═══════════════════════════════════════════╝"
if [ -f "$SCRIPT_DIR/logs/openclaw.log" ]; then
  echo ""
  echo "  📜 Log gateway gần nhất (20 dòng cuối):"
  echo "  ----------------------------------------"
  tail -20 "$SCRIPT_DIR/logs/openclaw.log" | sed 's/^/    /'
fi
if [ -f "$SCRIPT_DIR/logs/boot-diagnostic.txt" ]; then
  echo ""
  echo "  🔍 Boot diagnostic (đọc file đầy đủ tại logs/boot-diagnostic.txt):"
  echo "  ----------------------------------------"
  cat "$SCRIPT_DIR/logs/boot-diagnostic.txt" | sed 's/^/    /'
fi
if [ -f "$SCRIPT_DIR/logs/cron-runs.jsonl" ]; then
  echo ""
  echo "  ⏰ Cron events gần nhất (5 dòng cuối):"
  echo "  ----------------------------------------"
  tail -5 "$SCRIPT_DIR/logs/cron-runs.jsonl" | sed 's/^/    /'
fi
echo ""
read -p "  Nhấn Enter để đóng cửa sổ này..."
