import { describe, expect, test } from 'vitest';

import { readFetchMetadata } from '../fetch-metadata/index.js';
import type { FetchMetadata } from '../fetch-metadata/index.js';
import { isAllowedCookieRequest, isAllowedHeaderRequest } from './index.js';

const csrf = ['https://napochaan.com'];

const metadata = (overrides: Partial<FetchMetadata>): FetchMetadata => ({ origin: undefined, fetchSite: undefined, fetchDest: undefined, ...overrides });

// Pins the cookie CSRF decision table of Payload 3.84.1 (`dist/auth/extractJWT.js`, the `cookie`
// extraction method): Origin allowlist first, then no-allowlist passthrough, then Sec-Fetch-Site.
describe('isAllowedCookieRequest', () => {
  test('allows a listed Origin', () => {
    expect(isAllowedCookieRequest(metadata({ origin: 'https://napochaan.com' }), csrf)).toBe(true);
  });

  test('rejects an unlisted Origin', () => {
    expect(isAllowedCookieRequest(metadata({ origin: 'https://evil.example' }), csrf)).toBe(false);
  });

  test('allows any Origin when csrf is empty', () => {
    expect(isAllowedCookieRequest(metadata({ origin: 'https://evil.example' }), [])).toBe(true);
  });

  test('allows same-origin fetch without Origin', () => {
    expect(isAllowedCookieRequest(metadata({ fetchSite: 'same-origin' }), csrf)).toBe(true);
  });

  test('allows same-site fetch without Origin', () => {
    expect(isAllowedCookieRequest(metadata({ fetchSite: 'same-site' }), csrf)).toBe(true);
  });

  test('allows direct navigation without Origin', () => {
    expect(isAllowedCookieRequest(metadata({ fetchSite: 'none' }), csrf)).toBe(true);
  });

  test('rejects cross-site fetch without Origin', () => {
    expect(isAllowedCookieRequest(metadata({ fetchSite: 'cross-site' }), csrf)).toBe(false);
  });

  test('rejects a request with neither Origin nor Sec-Fetch-Site', () => {
    expect(isAllowedCookieRequest(metadata({}), csrf)).toBe(false);
  });

  test('allows a request with neither Origin nor Sec-Fetch-Site when csrf is empty', () => {
    expect(isAllowedCookieRequest(metadata({}), [])).toBe(true);
  });
});

// Access は Cf-Access-Jwt-Assertion をブラウザの CF_Authorization cookie から付けるので、header 由来でも
// クロスサイト要求に乗ってくる。ただし Access のログイン後の /admin への着地は Origin の無いクロスサイトの
// トップレベル GET なので、cookie の判定表をそのまま使うと正規の経路が落ちる(/admin より深いパスへの
// クロスサイト遷移は worker/middleware/path-policy/plugins/admin-landing/index.ts が /admin へ送る)。
type HeaderCase = { flow: string; request: Partial<FetchMetadata> };

describe('isAllowedHeaderRequest', () => {
  test.each<HeaderCase>([
    { flow: 'Access login callback landing on /admin (top-level cross-site GET)', request: { fetchSite: 'cross-site', fetchDest: 'document' } },
    { flow: 'admin same-origin XHR GET without Origin', request: { fetchSite: 'same-origin', fetchDest: 'empty' } },
    { flow: 'Live Preview same-origin iframe', request: { fetchSite: 'same-origin', fetchDest: 'iframe' } },
    { flow: 'admin same-origin thumbnail <img>', request: { fetchSite: 'same-origin', fetchDest: 'image' } },
    { flow: 'admin same-origin XHR POST / PATCH', request: { origin: 'https://napochaan.com', fetchSite: 'same-origin', fetchDest: 'empty' } },
    { flow: 'Server Action POST', request: { origin: 'https://napochaan.com', fetchSite: 'same-origin', fetchDest: 'empty' } },
    { flow: 'non-browser client (curl) without fetch metadata', request: {} },
    { flow: 'direct navigation typed into the address bar', request: { fetchSite: 'none', fetchDest: 'document' } },
  ])('allows $flow', ({ request }) => {
    expect(isAllowedHeaderRequest(metadata(request), csrf)).toBe(true);
  });

  test.each<HeaderCase>([
    { flow: 'cross-site form / fetch POST', request: { origin: 'https://evil.example', fetchSite: 'cross-site', fetchDest: 'document' } },
    { flow: 'redirect-tainted request with Origin: null', request: { origin: 'null', fetchSite: 'cross-site', fetchDest: 'document' } },
    { flow: 'cross-site <img>', request: { fetchSite: 'cross-site', fetchDest: 'image' } },
    { flow: 'cross-site <iframe>', request: { fetchSite: 'cross-site', fetchDest: 'iframe' } },
    { flow: 'cross-site <script>', request: { fetchSite: 'cross-site', fetchDest: 'script' } },
    { flow: 'cross-site no-cors fetch GET', request: { fetchSite: 'cross-site', fetchDest: 'empty' } },
    { flow: 'cross-site request with Sec-Fetch-Site but no Sec-Fetch-Dest', request: { fetchSite: 'cross-site' } },
  ])('rejects $flow', ({ request }) => {
    expect(isAllowedHeaderRequest(metadata(request), csrf)).toBe(false);
  });

  test('allows any Origin when csrf is empty', () => {
    expect(isAllowedHeaderRequest(metadata({ origin: 'https://evil.example' }), [])).toBe(true);
  });

  test('still rejects a cross-site subresource when csrf is empty', () => {
    expect(isAllowedHeaderRequest(metadata({ fetchSite: 'cross-site', fetchDest: 'image' }), [])).toBe(false);
  });
});

// 未知の Sec-Fetch-Site は readFetchMetadata で undefined になる。header を直接見ていた頃と判定が変わらないこと。
describe('unknown Sec-Fetch-Site through readFetchMetadata', () => {
  const unknown = readFetchMetadata(new Headers({ 'Sec-Fetch-Site': 'cross-origin', 'Sec-Fetch-Dest': 'image' }));

  test('cookie rule rejects it when csrf is set', () => {
    expect(isAllowedCookieRequest(unknown, csrf)).toBe(false);
  });

  test('header rule allows it', () => {
    expect(isAllowedHeaderRequest(unknown, csrf)).toBe(true);
  });
});
