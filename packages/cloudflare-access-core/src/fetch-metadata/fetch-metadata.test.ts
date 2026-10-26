import { describe, expect, test } from 'vitest';

import { readFetchMetadata } from './index.js';

describe('readFetchMetadata', () => {
  test('reads Origin, Sec-Fetch-Site and Sec-Fetch-Dest', () => {
    const headers = new Headers({ Origin: 'https://napochaan.com', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'empty' });

    expect(readFetchMetadata(headers)).toEqual({ origin: 'https://napochaan.com', fetchSite: 'same-origin', fetchDest: 'empty' });
  });

  test('returns undefined for every field when the headers are missing', () => {
    expect(readFetchMetadata(new Headers())).toEqual({ origin: undefined, fetchSite: undefined, fetchDest: undefined });
  });

  test('treats an empty Origin as missing', () => {
    expect(readFetchMetadata(new Headers({ Origin: '' })).origin).toBeUndefined();
  });

  // リダイレクトを跨いだ要求などはブラウザが "null" を送る。値としては残し、許可リストで判定させる。
  test('keeps Origin: null as the string "null"', () => {
    expect(readFetchMetadata(new Headers({ Origin: 'null' })).origin).toBe('null');
  });

  test.each(['same-origin', 'same-site', 'none', 'cross-site'] as const)('reads Sec-Fetch-Site %j', (fetchSite) => {
    expect(readFetchMetadata(new Headers({ 'Sec-Fetch-Site': fetchSite })).fetchSite).toBe(fetchSite);
  });

  test.each(['', 'cross-origin', 'Same-Origin'])('treats an unknown Sec-Fetch-Site %j as missing', (fetchSite) => {
    expect(readFetchMetadata(new Headers({ 'Sec-Fetch-Site': fetchSite })).fetchSite).toBeUndefined();
  });

  test('treats an empty Sec-Fetch-Dest as missing', () => {
    expect(readFetchMetadata(new Headers({ 'Sec-Fetch-Dest': '' })).fetchDest).toBeUndefined();
  });
});
