# MODOROClaw — Release strategy (dual-repo, single-source)

> Quy trình release cho MODOROClaw, áp dụng từ tháng 4/2026.

## 2 repo, mỗi cái 1 nhiệm vụ

| Repo | Nội dung | Audience | Anh push gì? |
|---|---|---|---|
| [`modoro-digital/MODOROClaw`](https://github.com/modoro-digital/MODOROClaw) | **Source code** (cross-platform: Mac + Windows) | Dev / sếp build local | `electron/`, `RUN.command`, `RESET.command`, `RUN.bat`, `README*.md`, workspace templates |
| [`modoro-digital/MODOROClaw-Setup`](https://github.com/modoro-digital/MODOROClaw-Setup) | **Pre-built installers** (.exe, .dmg) — không source | End users | Chỉ binary build artifact |

> **Lưu ý:** Repo `MODOROClaw` chứa source cho cả Mac + Windows (cross-platform Electron). Repo `MODOROClaw-Setup` chỉ chứa binary installer (.exe, .dmg) cho user cuối tải.

## Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Code on Windows (Desktop/claw)                              │
│     ↓                                                            │
│  2. push-to-mac-repo.bat                                         │
│     → push source lên modoro-digital/MODOROClaw              │
│     ↓                                                            │
│  3. Trên Windows: release-windows.bat                            │
│     → build EXE → push lên modoro-digital/MODOROClaw-Setup       │
│     ↓                                                            │
│  4. Trên Mac: pull MODOROClaw → build DMG → upload Setup     │
│     ↓                                                            │
│  5. User: tải installer từ MODOROClaw-Setup                      │
└─────────────────────────────────────────────────────────────────┘
```

## Push source code (Windows → MODOROClaw)

```bat
push-to-mac-repo.bat
```

Script này:
- `git add -A` toàn bộ source (electron/, workspace templates, scripts, docs)
- `.gitignore` đã loại trừ: `node_modules/`, `dist/`, `logs/`, `memory.db`, runtime files
- Commit + push lên branch `main`

**Tuyệt đối KHÔNG ảnh hưởng repo `MODOROClaw-Setup`** vì 2 origin khác nhau.

## Release Windows installer

```bat
release-windows.bat
```

Script này:
1. `electron-builder --win` → tạo `dist/MODOROClaw Setup 2.0.0.exe`
2. Clone (hoặc pull) repo `MODOROClaw-Setup` vào `../MODOROClaw-Setup/`
3. Copy installer vào `MODOROClaw-Setup/windows/`:
   - `MODOROClaw-Setup-2.0.0.exe` (version-stamped)
   - `MODOROClaw-Setup-latest.exe` (alias for "give me the latest")
4. Update `MODOROClaw-Setup/windows/README.md`
5. `git commit + push` lên `MODOROClaw-Setup main`

### Nếu file > 100 MB (GitHub limit cho file thường)

Dùng GitHub Releases thay vì commit thẳng:

```bat
:: Cài gh CLI một lần: https://cli.github.com
:: Sau đó:
gh release create v2.0.0 "dist\MODOROClaw Setup 2.0.0.exe" ^
  --repo modoro-digital/MODOROClaw-Setup ^
  --title "MODOROClaw v2.0.0" ^
  --notes "Windows installer for MODOROClaw v2.0.0"
```

GitHub Releases không tính vào git history → repo size không phình. User vào tab "Releases" tải.

## Release Mac DMG (làm trên Mac)

Sếp anh trên Mac:

```bash
git clone https://github.com/modoro-digital/MODOROClaw.git
cd MODOROClaw/electron
npm install
npm run build:mac:arm    # hoặc build:mac:intel hoặc build:mac:universal

# Output: ../dist/MODOROClaw-2.0.0-arm64.dmg

# Upload lên Setup repo:
cd ..
git clone https://github.com/modoro-digital/MODOROClaw-Setup.git ../MODOROClaw-Setup
mkdir -p ../MODOROClaw-Setup/mac
cp dist/*.dmg ../MODOROClaw-Setup/mac/
cd ../MODOROClaw-Setup
git add mac/
git commit -m "Release Mac DMG v2.0.0"
git push origin main
```

Hoặc dùng `gh release upload v2.0.0 dist/*.dmg --repo modoro-digital/MODOROClaw-Setup`.

## User cuối cài app như nào?

### Windows user:
1. Vào https://github.com/modoro-digital/MODOROClaw-Setup
2. Folder `windows/` → tải `MODOROClaw-Setup-latest.exe`
3. Double-click → cài → chạy MODOROClaw từ Start Menu

### Mac user:
1. Vào https://github.com/modoro-digital/MODOROClaw-Setup
2. Folder `mac/` → tải `MODOROClaw-arm64.dmg` (M1/M2/M3) hoặc `MODOROClaw-x64.dmg` (Intel)
3. Double-click DMG → kéo `MODOROClaw.app` vào `/Applications`
4. Lần đầu mở: right-click → Open (vì unsigned, xem [README-MAC.md](README-MAC.md))

## Phân quyền GitHub

Để 2 script trên chạy được, anh phải có:
- **Push permission** vào cả `MODOROClaw` và `MODOROClaw-Setup`
- **GitHub credential** đã setup local (1 trong 3):
  - `gh auth login` (recommended)
  - `git config --global credential.helper manager-core` (Windows Git Credential Manager)
  - SSH key đã add lên GitHub

Test bằng: `git push origin main --dry-run` từ trong thư mục đã clone repo.

## Câu hỏi thường gặp

**Q: Push vào `MODOROClaw` có động vào `MODOROClaw-Setup` không?**  
A: Không. 2 repo độc lập hoàn toàn. `push-to-mac-repo.bat` chỉ push lên `MODOROClaw` (origin của repo source). `release-windows.bat` chỉ push lên `MODOROClaw-Setup` (clone riêng vào `../MODOROClaw-Setup/`).

**Q: Build .exe nhưng không muốn push?**  
A: Chạy `cd electron && npx electron-builder --win`. Output ở `dist/`. Test xong tự upload thủ công nếu cần.

**Q: Sếp có cần build Windows không?**  
A: Không. Anh build EXE trên Windows local là đủ. Sếp chỉ build DMG trên Mac. Hai người chia việc theo platform mình có máy.

**Q: Có cần CI/CD (GitHub Actions) không?**  
A: Chưa cần. Workflow hiện tại đơn giản: anh code → build local → upload thủ công. Khi có nhiều dev hoặc release thường xuyên thì setup `.github/workflows/release.yml` chạy build trên cả Windows-runner và macOS-runner tự động.

**Q: Có cần code signing không?**  
A:
- **Windows EXE:** Không bắt buộc. User sẽ thấy SmartScreen warning lần đầu, bấm "More info → Run anyway" là xong. Code signing certificate ~$200/năm nếu muốn bỏ warning.
- **Mac DMG:** Không bắt buộc nhưng KHÓ CHỊU hơn. User phải right-click → Open lần đầu (vì Gatekeeper). Apple Developer ID $99/năm.

**Q: Auto-update?**  
A: Chưa setup. Update bằng cách user tải installer mới và cài đè. Nếu muốn auto-update sau này, dùng `electron-updater` + `electron-builder` config `publish: { provider: 'github', repo: 'MODOROClaw-Setup' }`.

## Files involved

| File | Role |
|---|---|
| [push-to-mac-repo.bat](push-to-mac-repo.bat) | Push source → MODOROClaw |
| [release-windows.bat](release-windows.bat) | Build EXE + push installer → MODOROClaw-Setup |
| [electron/package.json](electron/package.json) | electron-builder config (mac + win + nsis) |
| [electron/build/icon.ico](electron/build/icon.ico) | Windows icon |
| [electron/build/icon.icns](electron/build/icon.icns) | Mac icon |
| [README-MAC.md](README-MAC.md) | Mac build/install guide |
| [RELEASE-STRATEGY.md](RELEASE-STRATEGY.md) | This file |
