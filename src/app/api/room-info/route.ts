import { NextResponse } from 'next/server'
import { roomInfo } from '@/lib/vercel-relay'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const room = new URL(request.url).searchParams.get('room') ?? ''
  try {
    return NextResponse.json(await roomInfo(room), { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'signaling-storage-unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
}
