import { NextResponse } from 'next/server';

const WEB_USERNAME = process.env.WEB_USERNAME || '';
const WEB_PASSWORD = process.env.WEB_PASSWORD || '';
const AUTH_COOKIE  = 'tbm_auth';

function makeToken(user: string, pass: string) {
  return Buffer.from(`${user}:${pass}:tbm-v1`).toString('base64');
}

export async function POST(request: Request) {
  try {
    const { username, password } = await request.json();

    if (!WEB_USERNAME || !WEB_PASSWORD) {
      return NextResponse.json({ ok: false, error: 'Auth not configured on server' }, { status: 400 });
    }

    if (username === WEB_USERNAME && password === WEB_PASSWORD) {
      const response = NextResponse.json({ ok: true });
      const token = makeToken(WEB_USERNAME, WEB_PASSWORD);
      
      response.cookies.set(AUTH_COOKIE, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60, // 30 days
        path: '/',
      });

      return response;
    }

    return NextResponse.json({ ok: false, error: 'Invalid credentials' }, { status: 401 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
