import { NextRequest, NextResponse } from 'next/server'

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

async function sbUpsert(table: string, row: object) {
  const body = JSON.stringify(row)
  const headers: Record<string, string> = {
    apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY,
    'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates',
    'Content-Length': String(Buffer.byteLength(body)),
  }
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, { method: 'POST', headers, body })
  return res.status
}

export async function POST(req: NextRequest) {
  try {
    const { keyHash, reason } = await req.json()
    if (!keyHash || typeof keyHash !== 'string') {
      return NextResponse.json({ error: 'keyHash is required' }, { status: 400 })
    }
    const status = await sbUpsert('revoked_keys', { key_hash: keyHash, reason: reason ?? 'revoked-via-web' })
    if (status !== 200 && status !== 201) {
      return NextResponse.json({ error: 'Failed to revoke key' }, { status: 500 })
    }
    return NextResponse.json({ success: true, keyHash })
  } catch (err: any) {
    console.error('[api/keys/revoke]', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
