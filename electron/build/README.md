# Build resources

This directory holds platform-specific assets that `electron-builder` consumes when packaging.

## Required files

| File | Used by | How to generate |
|---|---|---|
| `icon.icns` | Mac DMG / .app icon | See "Generating icon.icns" below |
| `icon.ico` | Windows installer + EXE | See "Generating icon.ico" below |
| `entitlements.mac.plist` | Mac hardened runtime | Already committed |

## Generating `icon.icns` (Mac)

Source: a single 1024×1024 PNG (transparent background recommended).

**On a Mac:**
```bash
mkdir icon.iconset
sips -z 16 16     icon.png --out icon.iconset/icon_16x16.png
sips -z 32 32     icon.png --out icon.iconset/icon_16x16@2x.png
sips -z 32 32     icon.png --out icon.iconset/icon_32x32.png
sips -z 64 64     icon.png --out icon.iconset/icon_32x32@2x.png
sips -z 128 128   icon.png --out icon.iconset/icon_128x128.png
sips -z 256 256   icon.png --out icon.iconset/icon_128x128@2x.png
sips -z 256 256   icon.png --out icon.iconset/icon_256x256.png
sips -z 512 512   icon.png --out icon.iconset/icon_256x256@2x.png
sips -z 512 512   icon.png --out icon.iconset/icon_512x512.png
cp icon.png       icon.iconset/icon_512x512@2x.png
iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset
```

**Online (no Mac required):**
- https://cloudconvert.com/png-to-icns — upload PNG, download icns

## Generating `icon.ico` (Windows)

Use https://convertio.co/png-ico/ or `magick convert icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico` (ImageMagick).

## Tray icon

The tray icon (small status bar icon) lives at `electron/ui/tray-icon.png`. It's a separate
asset from the app icon. Use a 22×22 px PNG with transparency for best Mac menu bar rendering.

## Notes

- `electron-builder` will automatically pick up `icon.icns` / `icon.ico` if they exist in this dir
  AND are referenced from `mac.icon` / `win.icon` in `package.json` (already configured).
- If `icon.icns` is missing, electron-builder warns but still produces a DMG with a generic
  Electron icon. NOT a build failure — just ugly.
- For App Store distribution you must also generate `icon.iconset/icon_1024x1024.png` and
  enable `mac.target: "mas"`. This project targets `dmg` only.
