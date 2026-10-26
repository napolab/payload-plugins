// RFC 7230 tchar。cookie-name は token。
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// RFC 6265 §4.1.1 cookie-octet。CTL / 空白 / DQUOTE / "," / ";" / "\" と非 ASCII を含まない。
const COOKIE_OCTETS = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;
// §5.4 の OWS は SP と HTAB だけ。String#trim は Unicode 空白まで削るので使わない。
const OWS = /^[ \t]+|[ \t]+$/g;

type CookieEntry = readonly [name: string, value: string];

const trimOWS = (value: string): string => value.replace(OWS, '');

const unquote = (value: string): string => (value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value);

const parsePair = (pair: string): readonly CookieEntry[] => {
  const separator = pair.indexOf('=');
  // "=" なしは 6265bis だと名前なし cookie。名前で引けないので捨てる。
  if (separator === -1) return [];

  const name = trimOWS(pair.slice(0, separator));
  const value = unquote(trimOWS(pair.slice(separator + 1)));
  if (!TOKEN.test(name) || !COOKIE_OCTETS.test(value)) return [];

  return [[name, value]];
};

// RFC 6265 §4.2.1 の文法で Cookie ヘッダを読む。文法外の pair は丸ごと捨てる。
// - 同名は先勝ち。§5.4 で UA はより具体的な path の cookie を先に並べる。
// - percent-decode はしない。RFC に定義がなく、Access の JWT は base64url なので要らない(非正規形も受け入れてしまう)。
// - Map で返す。`__proto__` などの名前を普通のキーとして扱える。
export const parseCookies = (header: string): ReadonlyMap<string, string> =>
  // Map は後勝ちなので逆順に詰めて先勝ちにする。
  new Map(header.split(';').flatMap(parsePair).toReversed());

export const getCookie = (header: string, name: string): string | undefined => parseCookies(header).get(name);
