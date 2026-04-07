# MODOROClaw on macOS

> **Trạng thái:** Source code đã được fix toàn bộ platform-specific bugs cho Mac. Để **build DMG installer**, anh phải chạy `electron-builder` **trên một máy Mac thật** (không cross-compile được từ Windows).

## TL;DR — User chạy cài đặt thế nào

**Phương án A — Dev mode (chạy trực tiếp từ source code):**
1. Clone/copy thư mục `Desktop/claw/` sang Mac
2. Cài Node.js 22+ từ https://nodejs.org (hoặc `brew install node@22`)
3. `chmod +x RUN.command RESET.command`
4. Double-click `RUN.command` từ Finder
   - Lần đầu: tự `npm install` trong `electron/` (~3 phút)
   - Mở wizard → user nhập token Telegram + login Zalo + 9Router
   - Wizard tự `npm install -g openclaw 9router openzca`
5. Sau wizard: đóng/mở `RUN.command` lại = xong

**Phương án B — DMG packaged installer (1 file):**
1. Trên máy Mac (Apple Silicon hoặc Intel):
   ```bash
   cd electron
   npm install
   npm run build:mac        # universal binary (chậm)
   # hoặc
   npm run build:mac:arm    # chỉ M1/M2/M3
   npm run build:mac:intel  # chỉ Intel
   ```
2. Output: `dist/MODOROClaw-2.0.0-arm64.dmg` (hoặc x64/universal)
3. Gửi DMG cho user → user double-click → kéo `MODOROClaw.app` vào `/Applications`
4. Lần đầu mở: macOS Gatekeeper hỏi (xem mục "Gatekeeper" bên dưới)
5. App tự mở wizard, user vẫn phải có Node.js 22+ để wizard install các CLI tools

## Pre-requisites trên máy build (Mac)

| Tool | Cách cài | Tại sao |
|---|---|---|
| Node.js 22+ | `brew install node@22` hoặc nodejs.org | Build app + chạy tests |
| Xcode Command Line Tools | `xcode-select --install` | electron-builder cần `codesign` + `xcrun` |
| (Optional) Apple Developer ID | https://developer.apple.com ($99/năm) | Signing + notarization. Không có = user phải chấp nhận warning Gatekeeper |

## Pre-requisites trên máy user (Mac client)

| Tool | Bắt buộc? | Cách cài |
|---|---|---|
| **Node.js 22+** | ✅ BẮT BUỘC | https://nodejs.org → tải LTS 22 |
| `~/.npm-global` writable | ✅ BẮT BUỘC | Xem "Mac npm permission" bên dưới |
| Internet | ✅ Lần đầu | Wizard tự `npm install -g openclaw 9router openzca` (~5 phút) |

> **Tại sao user cần Node 22+:** Plugin Zalo (`openzca`) build với `tsup --target node22` nên cần Node 22.13+. App đã thêm pre-check ở wizard — nếu Node thấp hơn sẽ dừng với thông báo rõ ràng + link cài Node.

## Mac npm permission setup

`npm install -g` mặc định ghi vào `/usr/local/lib/node_modules` (Intel brew) hoặc `/opt/homebrew/lib/node_modules` (Apple Silicon brew). Cả hai đều cần `sudo` nếu user chưa setup user-prefix.

**KHUYẾN NGHỊ:** trước khi mở MODOROClaw lần đầu, user chạy:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.zshrc
source ~/.zshrc
```

Sau đó wizard MODOROClaw sẽ install vào `~/.npm-global/bin/` không cần sudo. App đã có pre-check phát hiện vấn đề này và hiện guidance cụ thể.

## Gatekeeper (chữ ký số macOS)

**Nếu KHÔNG có Apple Developer ID:**

DMG build ra sẽ unsigned. User mở app sẽ thấy:
> "MODOROClaw.app cannot be opened because the developer cannot be verified."

**Cách user vượt qua:**
- Right-click `MODOROClaw.app` → Open → Open (chấp nhận lần đầu)
- Hoặc Terminal: `xattr -d com.apple.quarantine /Applications/MODOROClaw.app`

**Nếu có Apple Developer ID ($99/năm):**

Set 2 env vars trước khi build:
```bash
export APPLE_ID="your-apple-id@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"  # tạo tại appleid.apple.com
export APPLE_TEAM_ID="XXXXXXXXXX"  # tìm tại developer.apple.com → Membership
export CSC_NAME="Developer ID Application: Your Name (XXXXXXXXXX)"

cd electron
npm run build:mac
```

electron-builder sẽ tự sign + notarize. User mở app không thấy warning.

## Build artifacts

| File | Nội dung | Size |
|---|---|---|
| `dist/MODOROClaw-2.0.0-arm64.dmg` | DMG cho Apple Silicon | ~150 MB |
| `dist/MODOROClaw-2.0.0-x64.dmg` | DMG cho Intel Mac | ~150 MB |
| `dist/MODOROClaw-2.0.0-universal.dmg` | Cả 2 (lớn hơn) | ~250 MB |

DMG chứa:
- `MODOROClaw.app` (Electron + main.js + node_modules với better-sqlite3 prebuilt cho Mac)
- Workspace templates (`Contents/Resources/workspace-templates/`) — AGENTS.md, SOUL.md, IDENTITY.md, skills/, prompts/, industry/, memory/, docs/, .learnings/
- `entitlements.mac.plist` đã embed (hardened runtime support)

## Reset trên Mac

User chạy:
```bash
cd /path/to/claw  # thư mục source nếu dev mode
chmod +x RESET.command
./RESET.command
```

Hoặc nếu dùng DMG (packaged), Reset bằng tay:
```bash
# Stop app
osascript -e 'quit app "MODOROClaw"'
pkill -f "openclaw.mjs" || true
pkill -f "openzca" || true
pkill -f "9router" || true

# Wipe state
rm -rf ~/.openclaw ~/.openzca
rm -rf "~/Library/Application Support/9router"
rm -rf "~/Library/Application Support/MODOROClaw"
rm -rf "~/Library/Application Support/modoro-claw"
rm -rf ~/Library/Logs/MODOROClaw

# Uninstall global npm tools
npm uninstall -g openclaw 9router openzca
```

## Troubleshooting

### Wizard báo "Khong tim thay Node.js"
→ User chưa cài Node hoặc Electron không thấy PATH (do launch từ Finder). Cài Node 22 từ https://nodejs.org rồi mở lại app.

### npm install -g báo EACCES
→ User chưa setup user-prefix. Chạy `mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global && echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.zshrc && source ~/.zshrc`.

### App báo "cannot be opened because the developer cannot be verified"
→ Gatekeeper block. Right-click app → Open. Hoặc `xattr -d com.apple.quarantine /Applications/MODOROClaw.app`.

### better-sqlite3 báo NODE_MODULE_VERSION mismatch
→ Postinstall script tự fix khi `npm install` chạy. Nếu vẫn lỗi: `cd electron && rm -rf node_modules/better-sqlite3/build && npm install`.

### Knowledge tab hiện trống dù đã upload file
→ Bug đã fix. App có disk-fallback: dù DB hỏng vẫn list được file từ `knowledge/<cat>/files/`. Restart app sẽ tự backfill DB từ disk.

### "Gateway is restarting" mid-reply
→ Bug đã fix triệt để. Nếu vẫn còn: `tail ~/.openclaw/logs/config-audit.jsonl` xem có entry `argv:["openclaw","config","set",...]` không. Nếu có = bị dính bug cũ → update source.

## Architecture: ai/cái gì chạy ở đâu

```
MODOROClaw.app (Electron 28)
├── Main process (Node 18 bundled)
│   ├── Spawns: openclaw gateway run    (system Node 22+)
│   ├── Spawns: 9router cli.js          (system Node 22+)
│   └── Spawns: openzca listen          (qua openclaw plugin, system Node 22+)
├── Renderer (Chromium)
│   └── dashboard.html
└── Resources/
    ├── app.asar (main.js + ui/ + node_modules)
    └── workspace-templates/  (AGENTS.md, skills/, prompts/, ...)

User home:
├── ~/.openclaw/                            (gateway state, plugins, logs)
├── ~/.openzca/profiles/default/            (Zalo cookies, listener-owner.json)
├── ~/Library/Application Support/9router/  (9router db.json — settings, providers)
└── ~/Library/Application Support/MODOROClaw/  (Electron userData = workspace khi packaged)
```

## Known limitations cho Mac (state hiện tại)

| Feature | Trạng thái Mac |
|---|---|
| Telegram | ✅ Hoạt động (HTTP API only, không phụ thuộc native) |
| Zalo via openzca | ⚠️ Cần Node 22+. Wizard pre-check + báo lỗi rõ. |
| 9Router | ✅ Hoạt động (systray có Mac binary) |
| Knowledge tab + better-sqlite3 | ✅ Prebuilt cho darwin-arm64 + darwin-x64 (v11.10.0) |
| Cron / scheduled jobs | ✅ Cross-platform (node-cron) |
| Google Calendar/Gmail | ❌ Chưa implement (gog-cli không tồn tại — dead code đã wrap) |
| Auto-update | ❌ Chưa cấu hình. Manual update bằng cách tải DMG mới. |
| Code signing | ⚠️ Cần Apple Developer ID ($99/năm). Không có = user phải right-click Open lần đầu. |

## Verification trên Mac sau khi build

Sau khi `npm run build:mac` xong, kiểm tra:

```bash
# 1. Verify DMG built
ls -lh dist/*.dmg

# 2. Verify app structure
hdiutil attach dist/MODOROClaw-*.dmg
ls /Volumes/MODOROClaw*/MODOROClaw.app/Contents/Resources/workspace-templates/  # Phai co AGENTS.md, skills/, ...
ls /Volumes/MODOROClaw*/MODOROClaw.app/Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/  # Phai co better_sqlite3.node
hdiutil detach /Volumes/MODOROClaw*

# 3. Install + test
cp -R /Volumes/MODOROClaw*/MODOROClaw.app /Applications/
open /Applications/MODOROClaw.app  # right-click Open neu Gatekeeper block
# → wizard hien ra → nhap token → tap "Cai dat OpenClaw"
# → kiem tra ~/Library/Logs/MODOROClaw/main.log neu co loi
```

## Files modified for Mac compatibility

| File | Change |
|---|---|
| `electron/package.json` | Mac block: icon, hardenedRuntime, entitlements, asarUnpack, extraResources, target arch |
| `electron/build/entitlements.mac.plist` | New — hardened runtime entitlements |
| `electron/build/README.md` | New — icon generation guide |
| `electron/main.js` | seedWorkspace uses `process.resourcesPath/workspace-templates` when packaged |
| `electron/main.js` | install-openclaw pre-checks Node version + npm permissions |
| `electron/main.js` | gog-cli setup-google → graceful "not implemented" instead of crash |
| `electron/main.js` | stop9Router kills process group on Mac (-pid SIGTERM) |
| `electron/main.js` | start9Router uses absolute node path via findNodeBin() |
| `RUN.command` | New — Mac launcher (dev mode) |
| `RESET.command` | New — Mac full reset (Mac paths) |
| `README-MAC.md` | This file |
