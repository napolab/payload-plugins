import { describe, expect, it } from 'vitest';

import { getCookie, parseCookies } from './index.js';

describe('parseCookies', () => {
  it('parses cookie pairs', () => {
    expect(parseCookies('a=1; b=2')).toEqual(
      new Map([
        ['a', '1'],
        ['b', '2'],
      ]),
    );
  });

  it('returns an empty map for an empty header', () => {
    expect(parseCookies('').size).toBe(0);
  });

  it('trims SP and HTAB around names and values', () => {
    expect(parseCookies(' \ta \t= \t1\t ;b=2')).toEqual(
      new Map([
        ['a', '1'],
        ['b', '2'],
      ]),
    );
  });

  it('does not trim other whitespace', () => {
    expect(parseCookies(' a=1').size).toBe(0);
  });

  it('keeps "=" inside the value', () => {
    expect(parseCookies('a=x=y').get('a')).toBe('x=y');
  });

  it('strips one pair of surrounding DQUOTEs', () => {
    expect(parseCookies('a="1"; b=""').get('a')).toBe('1');
    expect(parseCookies('b=""').get('b')).toBe('');
  });

  it('skips a value with a stray DQUOTE', () => {
    expect(parseCookies('a="1; b=2"; c=3').get('a')).toBeUndefined();
    expect(parseCookies('a=""1""').get('a')).toBeUndefined();
  });

  it.each([
    ['comma', 'a=x,y'],
    ['backslash', 'a=x\\y'],
    ['inner space', 'a=x y'],
    ['control character', 'a=x\u0001y'],
    ['non-ASCII', 'a=café'],
  ])('skips a value with a %s', (_label, header) => {
    expect(parseCookies(header).has('a')).toBe(false);
  });

  it('skips a pair without "="', () => {
    expect(parseCookies('a; b=2')).toEqual(new Map([['b', '2']]));
  });

  it('skips a pair with an empty name', () => {
    expect(parseCookies('=1; b=2')).toEqual(new Map([['b', '2']]));
  });

  it.each([
    ['space', 'a b=1'],
    ['separator', 'a(b)=1'],
    ['slash', 'a/b=1'],
  ])('skips a name with a %s', (_label, header) => {
    expect(parseCookies(header).size).toBe(0);
  });

  it('keeps the first occurrence of a duplicate name', () => {
    expect(parseCookies('a=1; a=2').get('a')).toBe('1');
  });

  it('does not percent-decode the value', () => {
    expect(parseCookies('a=%41').get('a')).toBe('%41');
  });

  it('stores __proto__ as a normal entry', () => {
    const cookies = parseCookies('__proto__=x; constructor=y');

    expect(cookies.get('__proto__')).toBe('x');
    expect(cookies.get('constructor')).toBe('y');
    expect(Object.getPrototypeOf(cookies)).toBe(Map.prototype);
  });
});

describe('getCookie', () => {
  it('returns the named cookie', () => {
    expect(getCookie('a=1; b=2', 'b')).toBe('2');
  });

  it('returns undefined for a missing cookie', () => {
    expect(getCookie('a=1', 'b')).toBeUndefined();
  });
});
