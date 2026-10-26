import type { FetchMetadata, FetchSite } from '../fetch-metadata/index.js';

const ALLOWED_FETCH_SITES: readonly FetchSite[] = ['same-origin', 'same-site', 'none'];

const isAllowedOrigin = (origin: string, csrf: readonly string[]): boolean => csrf.length === 0 || csrf.includes(origin);

// Mirrors the `cookie` extraction method of Payload 3.84.1 (`dist/auth/extractJWT.js`).
export const isAllowedCookieRequest = ({ origin, fetchSite }: FetchMetadata, csrf: readonly string[]): boolean => {
  if (origin !== undefined) return isAllowedOrigin(origin, csrf);
  if (csrf.length === 0) return true;

  return fetchSite !== undefined && ALLOWED_FETCH_SITES.includes(fetchSite);
};

// Cf-Access-Jwt-Assertion は Access がエッジで付けるが、元はブラウザが自動で送る CF_Authorization cookie。
// なのでクロスサイト要求にも乗ってくる。一方、Access ログイン直後の /admin への着地は IdP 経由の
// リダイレクトの末尾なので、Origin の無いクロスサイトのトップレベル GET になる。cookie の判定表
// (Origin 無し + cross-site は拒否)を使うとログインが成立しないので、クロスサイトの document だけは通す。
// この分岐が要るのは /admin への着地のためだけ。strategy は headers しか見られないので、それより深い
// admin パスへのクロスサイト遷移は、利用側の worker / middleware で /admin へリダイレクトさせること。
// - Origin がある("null" も含む) → csrf の許可リストで判定
// - Origin が無いクロスサイトのサブリソース(img / iframe / script / fetch など、Dest が document 以外) → 拒否
// - それ以外(トップレベル遷移、Origin を付けない同一 origin の GET、fetch metadata を送らない非ブラウザ) → 許可
export const isAllowedHeaderRequest = ({ origin, fetchSite, fetchDest }: FetchMetadata, csrf: readonly string[]): boolean => {
  if (origin !== undefined) return isAllowedOrigin(origin, csrf);
  if (fetchSite !== 'cross-site') return true;

  return fetchDest === 'document';
};
