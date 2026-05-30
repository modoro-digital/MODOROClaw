# HTTP requests template

Dùng `requests` (Python) hoặc native `fetch` (Node 18+). Avoid Playwright cho task HTTP đơn giản.

## GET JSON từ API

```python
"""GET data from JSON API."""
import sys, json, argparse, urllib.request, urllib.error

def main():
    p = argparse.ArgumentParser()
    p.add_argument('url')
    p.add_argument('--timeout', type=int, default=10)
    args = p.parse_args()
    try:
        req = urllib.request.Request(args.url, headers={'User-Agent': '9BizClaw/1.0'})
        with urllib.request.urlopen(req, timeout=args.timeout) as r:
            data = json.loads(r.read().decode('utf-8'))
        print(json.dumps(data, ensure_ascii=False, indent=2))
    except urllib.error.HTTPError as e:
        print(json.dumps({'error': f'HTTP {e.code}', 'detail': str(e)}), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(json.dumps({'error': str(e)}), file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
```

## POST với body + auth

```python
"""POST JSON to API with bearer token."""
import sys, json, argparse, urllib.request

def main():
    p = argparse.ArgumentParser()
    p.add_argument('url')
    p.add_argument('--body-file', help='Path to JSON file')
    p.add_argument('--token', help='Bearer token (or use env API_TOKEN)')
    args = p.parse_args()
    import os
    token = args.token or os.environ.get('API_TOKEN')
    body = open(args.body_file).read().encode() if args.body_file else b'{}'
    headers = {'Content-Type': 'application/json'}
    if token: headers['Authorization'] = f'Bearer {token}'
    req = urllib.request.Request(args.url, data=body, headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=30) as r:
        print(r.read().decode('utf-8'))

if __name__ == '__main__':
    main()
```

## Bulk check URLs (uptime monitor)

```python
"""Ping list URLs, return status code + latency."""
import sys, json, time, argparse, urllib.request, concurrent.futures

def check(url):
    try:
        t = time.time()
        req = urllib.request.Request(url, method='HEAD', headers={'User-Agent': '9BizClaw/1.0'})
        with urllib.request.urlopen(req, timeout=10) as r:
            return {'url': url, 'status': r.status, 'latency_ms': int((time.time() - t) * 1000)}
    except Exception as e:
        return {'url': url, 'status': 'ERROR', 'error': str(e)}

def main():
    p = argparse.ArgumentParser()
    p.add_argument('urls', nargs='+')
    args = p.parse_args()
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        results = list(ex.map(check, args.urls))
    print(json.dumps(results, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
```

## Notes

- Stdlib `urllib.request` đủ cho HTTP basic — TRÁNH install `requests` nếu không cần
- Khi cần cookies/session phức tạp → install `requests` qua pip
- Cho browser-rendered content → dùng playwright-browser.md template
- Timeout default 10-30s, cap 60s cho user-script (script-runner enforce)
- Đường dẫn proxy/CA: `urllib.request.ProxyHandler({'https': 'http://...'})`
