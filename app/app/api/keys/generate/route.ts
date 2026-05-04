import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  try {
    const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
    const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

    if (!SB_URL || !SB_KEY) {
      return NextResponse.json({ error: 'Supabase not configured on server' }, { status: 500 })
    }

    return NextResponse.json({
      error: 'License key generation requires the private signing key, which is only available on the admin machine. Use `node electron/scripts/generate-license.js` locally instead. Keys can still be listed and revoked from this web interface.'
    }, { status: 501 })
  } catch (err: any) {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
