import { err, errAsync, ok, ResultAsync } from 'neverthrow';
import type { Result } from 'neverthrow';

import { AccessIdentityFetchFailed, InvalidAccessIdentity } from '../errors/index.js';
import { accessIssuer } from '../verify/index.js';

// get-identity の応答から使う分だけ。応答には geo / device_sessions / ip なども入るが読まない。
export type AccessProfile = {
  email: string;
  name: string | undefined;
  picture: string | undefined;
  idp: { id: string; type: string } | undefined;
};

export type FetchAccessProfileArgs = {
  teamDomain: string;
  // Access の application token(検証済みのもの)。
  token: string;
  fetch?: typeof globalThis.fetch;
};

export const identityURL = (teamDomain: string): string => new URL('/cdn-cgi/access/get-identity', accessIssuer(teamDomain)).href;

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

// 継承したプロパティは読まない。
const readField = (value: unknown, key: string): unknown => {
  if (!isObject(value) || !Object.hasOwn(value, key)) return undefined;
  const field: unknown = Reflect.get(value, key);
  return field;
};

const readText = (value: unknown, key: string): string | undefined => {
  const field = readField(value, key);
  if (typeof field !== 'string') return undefined;

  const trimmed = field.trim();
  return trimmed === '' ? undefined : trimmed;
};

const isHTTPSURL = (raw: string): boolean => URL.canParse(raw) && new URL(raw).protocol === 'https:';

// <img src> にそのまま使われるので https の URL だけ通す。
const readPicture = (oidcFields: unknown): string | undefined => {
  const picture = readText(oidcFields, 'picture');
  if (picture === undefined || !isHTTPSURL(picture)) return undefined;

  return picture;
};

const readIdP = (body: unknown): AccessProfile['idp'] => {
  const idp = readField(body, 'idp');
  const id = readField(idp, 'id');
  const type = readField(idp, 'type');
  if (typeof id !== 'string' || typeof type !== 'string') return undefined;

  return { id, type };
};

export const toAccessProfile = (body: unknown): Result<AccessProfile, InvalidAccessIdentity> => {
  const email = readField(body, 'email');
  if (typeof email !== 'string' || email === '') return err(new InvalidAccessIdentity('email'));

  const oidcFields = readField(body, 'oidc_fields');
  return ok({
    email,
    name: readText(body, 'name') ?? readText(oidcFields, 'name'),
    picture: readPicture(oidcFields),
    idp: readIdP(body),
  });
};

// 未ログイン / 期限切れの token は login ページへの 302 になる。追うと HTML の 200 になって
// 「JSON でない」と誤って報告するので、redirect は追わずに失敗として扱う。
const requestIdentity = ({ teamDomain, token, fetch = globalThis.fetch }: FetchAccessProfileArgs): ResultAsync<Response, AccessIdentityFetchFailed> =>
  ResultAsync.fromPromise(
    fetch(identityURL(teamDomain), {
      headers: { cookie: `CF_Authorization=${token}` },
      redirect: 'manual',
    }),
    (cause) => new AccessIdentityFetchFailed(undefined, cause),
  );

const readJSON = (response: Response): ResultAsync<unknown, AccessIdentityFetchFailed | InvalidAccessIdentity> => {
  if (!response.ok) return errAsync(new AccessIdentityFetchFailed(response.status));

  return ResultAsync.fromPromise<unknown, InvalidAccessIdentity>(response.json(), (cause) => new InvalidAccessIdentity('json', cause));
};

export const fetchAccessProfile = (args: FetchAccessProfileArgs): ResultAsync<AccessProfile, AccessIdentityFetchFailed | InvalidAccessIdentity> =>
  requestIdentity(args).andThen(readJSON).andThen(toAccessProfile);
