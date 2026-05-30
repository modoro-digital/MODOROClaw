# SQLite — query workspace databases

`memory.db` (Knowledge tab) và workspace SQLite files. stdlib `sqlite3` đủ.

## Query memory.db (knowledge documents)

```python
"""Query knowledge documents từ memory.db."""
import sys, sqlite3, json, argparse, os

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--category', help='cong-ty, san-pham, nhan-vien')
    p.add_argument('--search', help='Keyword search trong content')
    p.add_argument('--limit', type=int, default=20)
    args = p.parse_args()
    db_path = os.path.join(os.environ.get('9BIZ_WORKSPACE', '.'), 'memory.db')
    if not os.path.exists(db_path):
        print('memory.db not found', file=sys.stderr); sys.exit(1)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    q = 'SELECT id, filename, category, summary, content_length FROM documents WHERE 1=1'
    params = []
    if args.category:
        q += ' AND category = ?'; params.append(args.category)
    if args.search:
        q += ' AND content LIKE ?'; params.append(f'%{args.search}%')
    q += ' ORDER BY created_at DESC LIMIT ?'; params.append(args.limit)
    rows = [dict(r) for r in conn.execute(q, params).fetchall()]
    print(json.dumps(rows, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
```

## Customer LTV (qua memory zalo-users + custom log)

```python
"""Tính LTV per Zalo customer từ memory + audit log."""
import sys, os, json, re, glob, argparse
from collections import defaultdict

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--min-orders', type=int, default=1)
    args = p.parse_args()
    ws = os.environ.get('9BIZ_WORKSPACE', '.')
    users_dir = os.path.join(ws, 'memory', 'zalo-users')
    if not os.path.isdir(users_dir):
        print('memory/zalo-users not found', file=sys.stderr); sys.exit(1)
    ltv = []
    for f in glob.glob(os.path.join(users_dir, '*.md')):
        with open(f, encoding='utf-8') as fh:
            content = fh.read()
        sender_id = os.path.basename(f).replace('.md', '')
        # Parse name from frontmatter
        name_m = re.search(r'^name:\s*(.+)$', content, re.M)
        name = name_m.group(1).strip() if name_m else sender_id
        # Count "Đơn hàng" / "đơn" mentions as proxy
        order_count = len(re.findall(r'đơn\s+(?:hàng\s+)?(?:mua|đặt)', content, re.I))
        # Extract VNĐ amounts (very rough)
        amounts = re.findall(r'(\d{1,3}(?:[.,]\d{3})+|\d+)\s*(?:đ|đồng|VNĐ|k|tr|m)', content, re.I)
        total = sum(int(re.sub(r'[.,]', '', a)) for a in amounts if a.isdigit() or re.sub(r'[.,]', '', a).isdigit())
        if order_count >= args.min_orders:
            ltv.append({'senderId': sender_id, 'name': name, 'orders': order_count, 'estimated_ltv_vnd': total})
    ltv.sort(key=lambda x: x['estimated_ltv_vnd'], reverse=True)
    print(json.dumps(ltv, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
```

## Inactive customer detection

```python
"""Tìm khách Zalo không tương tác >N ngày."""
import sys, os, re, glob, argparse, datetime as dt

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--days', type=int, default=60)
    args = p.parse_args()
    ws = os.environ.get('9BIZ_WORKSPACE', '.')
    cutoff = (dt.datetime.now() - dt.timedelta(days=args.days)).timestamp()
    inactive = []
    for f in glob.glob(os.path.join(ws, 'memory', 'zalo-users', '*.md')):
        mtime = os.path.getmtime(f)
        if mtime < cutoff:
            sender_id = os.path.basename(f).replace('.md', '')
            with open(f, encoding='utf-8') as fh:
                content = fh.read()
            name_m = re.search(r'^name:\s*(.+)$', content, re.M)
            name = name_m.group(1).strip() if name_m else sender_id
            days_ago = int((dt.datetime.now().timestamp() - mtime) / 86400)
            inactive.append({'senderId': sender_id, 'name': name, 'daysInactive': days_ago})
    inactive.sort(key=lambda x: -x['daysInactive'])
    import json; print(json.dumps(inactive, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
```

## Notes

- `9BIZ_WORKSPACE` env var auto-set bởi gateway — path tới workspace
- `memory/zalo-users/<senderId>.md` chứa frontmatter (name, lastSeen, tags) + append history
- `memory.db` schema: `documents(id, filename, category, content, summary, visibility, created_at)`
- Mọi date column trong DB là ISO 8601 strings
- KHÔNG modify DB từ script — chỉ read-only (write qua API endpoint)
