import { NextRequest, NextResponse } from 'next/server'

const SESSION_SECRET = process.env.SESSION_SECRET ?? 'claw-license-mgr-secret-2026-v1'
const COOKIE_NAME = 'claw_session'

function computeHmacHex(value: string): string {
  const crypto = require('crypto') as typeof import('crypto')
  const hmac = crypto.createHmac('sha256', SESSION_SECRET)
  hmac.update(value)
  return hmac.digest('hex').slice(0, 16)
}

export async function GET(req: NextRequest) {
  try {
    const session = req.cookies.get(COOKIE_NAME)
    if (!session) return NextResponse.json({ ok: false }, { status: 401 })

    const parts = session.value.split('.')
    if (parts.length !== 2) return NextResponse.json({ ok: false }, { status: 401 })

    const [value, expectedSig] = parts
    const computed = computeHmacHex(value)
    if (computed !== expectedSig) return NextResponse.json({ ok: false }, { status: 401 })

    let data: any
    try { data = JSON.parse(value) } catch { return NextResponse.json({ ok: false }, { status: 401 }) }

    return NextResponse.json({ ok: true, username: data.username })
  } catch (err) {
    console.error('[auth/check]', err)
    return NextResponse.json({ ok: false }, { status: 401 })
  }
}
