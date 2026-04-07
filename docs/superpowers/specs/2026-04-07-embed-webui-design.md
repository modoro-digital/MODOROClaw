# Embed 9Router + OpenClaw Web UI — Design Spec

**Date:** 2026-04-07
**Status:** Approved

## Mục tiêu

Mọi thứ gói gọn trong app MODOROClaw. CEO không cần mở browser — 2 web UI (9Router + OpenClaw gateway) hiện trực tiếp dưới dạng tab trong dashboard.

## Approach: Strip security headers + iframe

OpenClaw gateway có `X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'` chặn embed. Fix bằng cách intercept response qua `webRequest.onHeadersReceived`, strip 2 headers này CHỈ cho local trusted origins (`127.0.0.1:18789`, `127.0.0.1:20128` + localhost equivalents).

Sau đó embed bằng `<iframe>` chuẩn HTML trong page mới của dashboard.

## Components

### 1. Header stripper (electron/main.js)

Trong `app.whenReady()`:

```javascript
const TRUSTED_LOCAL = [
  'http://127.0.0.1:18789', 'http://localhost:18789',
  'http://127.0.0.1:20128', 'http://localhost:20128',
];
session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
  const url = details.url || '';
  if (!TRUSTED_LOCAL.some(o => url.startsWith(o))) {
    return callback({ responseHeaders: details.responseHeaders });
  }
  const headers = { ...details.responseHeaders };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'x-frame-options') delete headers[key];
    if (key.toLowerCase() === 'content-security-policy') {
      headers[key] = headers[key].map(v =>
        v.split(';').filter(d => !d.trim().toLowerCase().startsWith('frame-ancestors')).join(';')
      );
    }
  }
  callback({ responseHeaders: headers });
});
```

### 2. Sidebar update

Thay 2 button "9Router" + "Gateway UI" cũ trong mục "Công cụ" thành menu item dùng `switchPage`:

```html
<div class="sidebar-menu-item" data-page="9router" onclick="switchPage('9router')">
  <span class="icon" data-icon="cpu"></span><span class="label">9Router</span>
</div>
<div class="sidebar-menu-item" data-page="openclaw" onclick="switchPage('openclaw')">
  <span class="icon" data-icon="zap"></span><span class="label">OpenClaw</span>
</div>
```

### 3. Pages mới

`page-9router` + `page-openclaw`, cùng template:

- Page header: icon + title + sub + nút Reload + nút "Mở trong browser ↗"
- `embed-wrap` chứa `<iframe class="embed-frame">`
- CSS full-flex trong viewport

### 4. Lazy loading

```javascript
const embedLoaded = { '9router': false, 'openclaw': false };
function ensureEmbedLoaded(name) {
  if (embedLoaded[name]) return;
  const url = name === '9router' ? 'http://127.0.0.1:20128/' : 'http://127.0.0.1:18789/';
  document.getElementById('iframe-' + name).src = url;
  embedLoaded[name] = true;
}
```

Hook trong `switchPage`:
```javascript
if (page === '9router' || page === 'openclaw') ensureEmbedLoaded(page);
```

Switch tab qua lại không reload — giữ session/state trong iframe.

## Auth

- **9Router**: không cần auth (local port mở)
- **OpenClaw**: cần token, web UI có flow nhập token + lưu localStorage. CEO copy token từ sidebar token box (đã có sẵn). Lần sau không cần nhập lại (localStorage persist trong session Electron).

## Fresh-install compatibility

- Code nằm trong source tree (`electron/main.js`, `electron/ui/dashboard.html`)
- Không có runtime patch cần re-apply
- User mới cài: wizard xong → dashboard có sẵn 2 page → click vào load iframe ngay

## Risk + Mitigation

| Risk | Mitigation |
|------|-----------|
| WebSocket trong OpenClaw không kết nối được | Test sau implement; nếu fail → strip thêm `connect-src` directive |
| Token phải nhập lại mỗi lần | localStorage Electron session persist → OK trong cùng app session; nếu cross-restart fail → preload script inject |
| Iframe layout overflow | `width:100%; height:100%` + `embed-wrap flex:1; min-height:0` xử lý |

## Files

| File | Thay đổi |
|------|---------|
| `electron/main.js` | +header stripper trong `whenReady` |
| `electron/ui/dashboard.html` | -2 button cũ, +2 menu item, +2 page, +CSS, +JS embed loader |
| `CLAUDE.md` | +entry vào patches list |
