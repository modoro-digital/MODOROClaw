import { NextRequest, NextResponse } from 'next/server'

const COOKIE_NAME = 'claw_session'
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'claw-license-mgr-secret-2026-v1'

function unsign(signed: string): boolean {
  const parts = signed.split('.')
  if (parts.length !== 2) return false
  const [value, expectedSig] = parts
  const crypto = require('crypto') as typeof import('crypto')
  const hmac = crypto.createHmac('sha256', SESSION_SECRET)
  hmac.update(value)
  const actualSig = hmac.digest('hex').slice(0, 16)
  return actualSig === expectedSig
}

export function middleware(req: NextRequest) {
  const url = req.nextUrl.pathname

  // Public paths — allow
  if (
    url === '/' ||
    url.startsWith('/api/auth/login') ||
    url.startsWith('/api/auth/logout') ||
    url.startsWith('/_next') ||
    url.startsWith('/favicon') ||
    url.includes('.')
  ) {
    return NextResponse.next()
  }

  const session = req.cookies.get(COOKIE_NAME)
  if (!session || !unsign(session.value)) {
    // SPA: redirect to root (root shows login)
    return NextResponse.redirect(new URL('/', req.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!api/auth/login|_next/static|_next/image|favicon.ico).*)'],
}
