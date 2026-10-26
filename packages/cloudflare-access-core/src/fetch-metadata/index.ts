export type FetchSite = 'same-origin' | 'same-site' | 'none' | 'cross-site';

export type FetchMetadata = {
  origin: string | undefined;
  fetchSite: FetchSite | undefined;
  fetchDest: string | undefined;
};

const FETCH_SITES: readonly string[] = ['same-origin', 'same-site', 'none', 'cross-site'] satisfies readonly FetchSite[];

const isFetchSite = (value: string): value is FetchSite => FETCH_SITES.includes(value);

// 空文字は付いていないのと同じ扱い。
const readHeader = (headers: Headers, name: string): string | undefined => {
  const value = headers.get(name);
  if (value === null || value === '') return undefined;

  return value;
};

// 未知の値は付いていないのと同じ扱い。
const readFetchSite = (headers: Headers): FetchSite | undefined => {
  const value = readHeader(headers, 'Sec-Fetch-Site');
  if (value === undefined || !isFetchSite(value)) return undefined;

  return value;
};

// "null" はそのまま残す(csrf の許可リストで判定する)。
export const readFetchMetadata = (headers: Headers): FetchMetadata => ({
  origin: readHeader(headers, 'Origin'),
  fetchSite: readFetchSite(headers),
  fetchDest: readHeader(headers, 'Sec-Fetch-Dest'),
});
