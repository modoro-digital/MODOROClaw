# Playwright browser automation template

Cho task scrape JS-rendered page, fill form, login session. Cần install Playwright + Chromium (~120MB).

## ⚠ Pre-flight check

Trước khi generate Playwright script, check Playwright availability:

```python
"""Check Playwright + Chromium installed."""
import sys
try:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        browser.close()
    print('OK')
except ImportError:
    print('Playwright not installed. Install: pip install playwright && python -m playwright install chromium', file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print(f'Playwright error: {e}', file=sys.stderr); sys.exit(1)
```

Nếu fail → báo CEO cài Playwright lần đầu (giống Python embedded — lazy download).

## Scrape product prices

```python
"""Scrape giá sản phẩm từ một website (cần CSS selectors)."""
import sys, json, argparse
from playwright.sync_api import sync_playwright

def main():
    p = argparse.ArgumentParser()
    p.add_argument('url')
    p.add_argument('--selector', required=True, help='CSS selector for product cards')
    p.add_argument('--name-selector', required=True)
    p.add_argument('--price-selector', required=True)
    p.add_argument('--limit', type=int, default=10)
    p.add_argument('--headless', action='store_true', default=True)
    args = p.parse_args()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=args.headless)
        ctx = browser.new_context(user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
        page = ctx.new_page()
        page.goto(args.url, wait_until='networkidle', timeout=30000)
        cards = page.query_selector_all(args.selector)[:args.limit]
        results = []
        for c in cards:
            name_el = c.query_selector(args.name_selector)
            price_el = c.query_selector(args.price_selector)
            if name_el and price_el:
                results.append({
                    'name': name_el.inner_text().strip(),
                    'price': price_el.inner_text().strip(),
                })
        browser.close()
        print(json.dumps(results, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
```

## Login + scrape behind auth

```python
"""Login portal và scrape dashboard (session persistent)."""
import sys, json, argparse, os
from playwright.sync_api import sync_playwright

def main():
    p = argparse.ArgumentParser()
    p.add_argument('login_url')
    p.add_argument('dashboard_url')
    p.add_argument('--username', required=True)
    p.add_argument('--password-env', default='SCRAPE_PASSWORD')
    p.add_argument('--user-selector', default='input[name="username"]')
    p.add_argument('--pass-selector', default='input[name="password"]')
    p.add_argument('--submit-selector', default='button[type="submit"]')
    args = p.parse_args()
    password = os.environ.get(args.password_env)
    if not password:
        print(f'Set env {args.password_env}', file=sys.stderr); sys.exit(1)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        # Persistent context: cookies survive sessions
        user_data_dir = os.path.join(os.environ.get('9BIZ_WORKSPACE', '.'), 'browser-sessions', 'default')
        ctx = pw.chromium.launch_persistent_context(user_data_dir, headless=True)
        page = ctx.new_page()
        page.goto(args.login_url)
        # Skip login if already authenticated (check cookie)
        if not page.locator(args.user_selector).count():
            page.goto(args.dashboard_url); print(page.content()[:1000]); ctx.close(); return
        page.fill(args.user_selector, args.username)
        page.fill(args.pass_selector, password)
        page.click(args.submit_selector)
        page.wait_for_load_state('networkidle', timeout=15000)
        page.goto(args.dashboard_url)
        page.wait_for_load_state('networkidle', timeout=15000)
        # Extract data — customize selectors
        print(page.content()[:5000])
        ctx.close()

if __name__ == '__main__':
    main()
```

## Notes

- **Install size:** ~120MB Chromium binary. Bot phải prompt CEO cài lần đầu (giống Python embedded).
- **Sessions persistent:** `launch_persistent_context(user_data_dir)` lưu cookies vào `workspace/browser-sessions/`. CEO login 1 lần, tháng sau chạy lại không cần re-login.
- **Anti-bot:** Một số site detect Playwright headless. Thử `headless=False` cho debug, hoặc add stealth plugin.
- **Selectors:** CEO ko biết CSS — bot tự đoán từ task ("nút đăng nhập" → `button:has-text("Đăng nhập")` hoặc `[type=submit]`). Iteration nếu fail.
- **Captcha:** Khi gặp captcha → script trả "CAPTCHA detected" → bot báo CEO solve manual lần đầu.
- Cần Python package: `pip install playwright` + `python -m playwright install chromium`
