// ============================================================
// Next.js Middleware — Web UI Login Gate
// Protects ALL pages with username + password (env vars).
// Set WEB_USERNAME and WEB_PASSWORD in your .env to enable.
// If neither is set, the app is open (no login required).
// ============================================================
import { NextRequest, NextResponse } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { hasLocale } from 'next-intl';
import { routing } from './i18n/routing';

const intlMiddleware = createMiddleware(routing);

// ── Auth config ───────────────────────────────────────────────
const WEB_USERNAME = process.env.WEB_USERNAME || '';
const WEB_PASSWORD = process.env.WEB_PASSWORD || '';
const AUTH_ENABLED = Boolean(WEB_USERNAME && WEB_PASSWORD);
const AUTH_COOKIE  = 'tbm_auth';
const LOGIN_PATH   = '/auth/login';

// ── Public paths that never require auth ─────────────────────
const PUBLIC_PREFIXES = [
  '/auth/',
  '/api/',
  '/_next/',
  '/icons/',
  '/images/',
  '/favicon',
  '/manifest',
  '/sitemap',
  '/poll-worker',
  '/auto-start-logic',
];

function isPublic(pathname) {
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

// ── Simple auth token (hash of user:pass, no external deps) ──
function makeToken(user, pass) {
  // btoa works in edge runtime
  return btoa(`${user}:${pass}:tbm-v1`);
}

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always pass through public paths
  if (isPublic(pathname)) {
    // Inject locale header for intl middleware on non-api paths
    if (!pathname.startsWith('/api/')) {
      return addLocaleHeader(request);
    }
    return NextResponse.next();
  }

  // If auth is not configured → open access (original behaviour)
  if (!AUTH_ENABLED) {
    return addLocaleHeader(request);
  }

  // Check for valid auth cookie
  const cookie = request.cookies.get(AUTH_COOKIE)?.value;
  const expected = makeToken(WEB_USERNAME, WEB_PASSWORD);

  if (cookie === expected) {
    return addLocaleHeader(request);
  }

  // Not authenticated → redirect to login
  const loginUrl = new URL(LOGIN_PATH, request.url);
  loginUrl.searchParams.set('from', pathname);
  return NextResponse.redirect(loginUrl);
}

function addLocaleHeader(request: NextRequest) {
  const first = request.nextUrl.pathname.split('/').filter(Boolean)[0];
  const locale = first && hasLocale(routing.locales, first) ? first : routing.defaultLocale;
  const headers = new Headers(request.headers);
  headers.set('x-tbm-locale', locale);
  return intlMiddleware(new NextRequest(request, { headers }));
}

export const config = {
  matcher: [
    '/((?!_next|icons|poll-worker|auto-start-logic|favicon.ico|sitemap.xml|manifest.json|images).*)',
  ],
};
