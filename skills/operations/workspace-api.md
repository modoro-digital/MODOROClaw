---
name: workspace-api
description: Workspace API port 20200 — doc/ghi/list file noi bo
metadata:
  version: 1.0.0
---

# Workspace API — doc/ghi file noi bo

Cung server port 20200. Phien Telegram CEO tu xac thuc khi `web_fetch` goi API local. KHONG doc `cron-api-token.txt`, KHONG them `token=<token>`.

## Doc file (khong can token)

```
web_fetch http://127.0.0.1:20200/api/workspace/read?path=.learnings/LEARNINGS.md
```

Whitelist: `LEARNINGS.md`, `.learnings/LEARNINGS.md`, `memory/*.md`, `memory/zalo-users/*.md`, `memory/zalo-groups/*.md`, `knowledge/*/index.md`, `IDENTITY.md`, `schedules.json`, `custom-crons.json`, `logs/cron-runs.jsonl`.

## Append vao LEARNINGS.md

```
web_fetch http://127.0.0.1:20200/api/workspace/append?path=.learnings/LEARNINGS.md&content=L-042+...
```

Max 2000 bytes. Chi LEARNINGS.md.

## Them Knowledge FAQ

```
web_fetch http://127.0.0.1:20200/api/knowledge/add?category=san-pham&title=Chinh+sach+tra+gop&content=Noi+dung+FAQ
```

Category: `cong-ty`, `san-pham`, `nhan-vien`. Append vao `knowledge/<category>/index.md`.

## Liet ke file

```
web_fetch http://127.0.0.1:20200/api/workspace/list?dir=memory/zalo-users/
```

Whitelist: `.learnings/`, `memory/`, `memory/zalo-users/`, `memory/zalo-groups/`, `knowledge/*/`.
