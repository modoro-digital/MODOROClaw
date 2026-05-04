import { NextRequest, NextResponse } from 'next/server'

const COOKIE_NAME = 'claw_session'
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'claw-license-mgr-secret-2026-v1'

async function computeHmacHex(value: string): Promise<string> {
  const encoder = new TextEncoder()
  const keyData = encoder.encode(SESSION_SECRET)
  const messageData = encoder.encode(value)

  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  )
  const sigBuffer = await crypto.subtle.sign('HMAC', cryptoKey, messageData)
  const sigBytes = new Uint8Array(sigBuffer)
  // First 16 hex chars (matching server: hmac.digest('hex').slice(0, 16))
  let hex = ''
  for (let i = 0; i < 8; i++) hex += sigBytes[i].toString(16).padStart(2, '0')
  return hex
}

async function verifyHmac(value: string, expectedSig: string): Promise<boolean> {
  try {
    const computed = await computeHmacHex(value)
    return computed === expectedSig
  } catch {
    return false
  }
}

export async function middleware(req: NextRequest) {
  const url = req.nextUrl.pathname

  // Public paths
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
  if (!session) {
    return NextResponse.redirect(new URL('/', req.url))
  }

  const parts = session.value.split('.')
  if (parts.length !== 2) {
    return NextResponse.redirect(new URL('/', req.url))
  }

  const [value, expectedSig] = parts
  const ok = await verifyHmac(value, expectedSig)
  if (!ok) {
    return NextResponse.redirect(new URL('/', req.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!api/auth/login|api/auth/logout|_next/static|_next/image|favicon.ico).*)'],
}
