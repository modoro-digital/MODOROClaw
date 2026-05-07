# 9BizClaw License Server

Cloudflare Worker + KV for license key management.

## Setup

```bash
npm install -g wrangler
wrangler login

# Create KV namespace
wrangler kv:namespace create LICENSE_KV
# Copy the id from output into wrangler.toml

# Set admin secret
wrangler secret put ADMIN_SECRET

# Deploy
wrangler deploy
```

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/activate | - | Activate key on a machine |
| POST | /api/validate | - | Validate key + machine binding |
| POST | /api/admin/generate | Bearer | Generate new keys |
| POST | /api/admin/list | Bearer | List all keys |
| POST | /api/admin/revoke | Bearer | Revoke a key |

## Admin CLI

```bash
export LICENSE_SERVER_URL=https://license.modoro.com.vn
export ADMIN_SECRET=your-secret

node scripts/generate-keys.js 10 --note "Launch batch"
node scripts/generate-keys.js list
node scripts/generate-keys.js revoke CLAW-AB23-XY45-MN67
```
