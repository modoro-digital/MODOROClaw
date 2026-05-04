import { NextRequest, NextResponse } from 'next/server'

const USERS: Record<string, string> = {
  'peterbui85': '9bizclaw#3211',
}

const SESSION_SECRET = process.env.SESSION_SECRET ?? 'claw-license-mgr-secret-2026-v1'
const COOKIE_NAME = 'claw_session'
const SESSION_TTL = 7 * 24 * 60 * 60 // 7 days

function signSession(value: string): string {
  const crypto = require('crypto') as typeof import('crypto')
  const hmac = crypto.createHmac('sha256', SESSION_SECRET)
  hmac.update(value)
  return value + '.' + hmac.digest('hex').slice(0, 16)
}

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json()
    if (!USERS[username] || USERS[username] !== password) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }
    const sessionData = JSON.stringify({ username, ts: Date.now() })
    const signed = signSession(sessionData)
    const res = NextResponse.json({ ok: true, username })
    res.cookies.set(COOKIE_NAME, signed, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_TTL,
      path: '/',
    })
    return res
  } catch (err) {
    console.error('[login] error:', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
