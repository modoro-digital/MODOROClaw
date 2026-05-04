import { NextRequest, NextResponse } from 'next/server'

const COOKIE_NAME = 'claw_session'
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'claw-license-mgr-secret-2026-v1'

function computeHmacHex(value: string): string {
  // Use built-in crypto module (Node.js runtime — works here, not in Edge)
  const crypto = require('crypto') as typeof import('crypto')
  const hmac = crypto.createHmac('sha256', SESSION_SECRET)
  hmac.update(value)
  return hmac.digest('hex').slice(0, 16)
}

function verifyHmac(value: string, expectedSig: string): boolean {
  try {
    const computed = computeHmacHex(value)
    return computed === expectedSig
  } catch {
    return false
  }
}

export async function middleware(req: NextRequest) {
  const url = req.nextUrl.pathname

  // Allow all requests through — auth is handled per-API in Node.js runtime
  return NextResponse.next()
}

export const config = {
  // Match everything — middleware just passes through
  matcher: ['/((?!api/auth/login|_next/static|_next/image|favicon.ico).*)'],
}
