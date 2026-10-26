import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { err, ok, ResultAsync } from 'neverthrow';
import type { Result } from 'neverthrow';

import { InvalidAccessClaims, InvalidAccessToken, MissingAccessEmail, WrongAccessTokenType } from '../errors/index.js';
import type { AccessJWTError } from '../errors/index.js';

export type AccessIdentity = { email: string };

// issuedAt は Access にログインした時刻(JWT の iat)。Access のセッションごとに 1 回だけ何かしたい時に使う。
export type AccessSessionIdentity = AccessIdentity & { issuedAt: Date };

export type VerifyAccessJWTArgs = {
  token: string;
  teamDomain: string;
  aud: readonly string[];
  keys: JWTVerifyGetKey;
};

// @hono/cloudflare-access と同じ許容値(秒)。
const CLOCK_TOLERANCE_SECONDS = 30;

export const accessIssuer = (teamDomain: string): string => `https://${teamDomain}.cloudflareaccess.com`;

// jose の remote JWKS は自前でキャッシュする。呼び出し側が 1 回だけ作って使い回すこと。
export const createAccessKeys = (teamDomain: string): JWTVerifyGetKey => createRemoteJWKSet(new URL('/cdn-cgi/access/certs', accessIssuer(teamDomain)));

// JWT payload から呼び出し側の identity を組み立てる。IdP の独自 claim は `custom` に入る(約 1KB 超は Access が落とす)。
export type AccessIdentityAdapter<T> = (payload: JWTPayload) => Result<T, AccessJWTError>;

// service token には email がないので弾く。
export const emailIdentity: AccessIdentityAdapter<AccessIdentity> = (payload) => {
  const email = payload['email'];
  if (typeof email !== 'string' || email === '') return err(new MissingAccessEmail());

  return ok({ email });
};

const readIssuedAt = (payload: JWTPayload): Result<Date, InvalidAccessClaims> => {
  const iat = payload['iat'];
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return err(new InvalidAccessClaims('iat'));

  return ok(new Date(iat * 1000));
};

export const sessionIdentity: AccessIdentityAdapter<AccessSessionIdentity> = (payload) =>
  emailIdentity(payload).andThen((identity) => readIssuedAt(payload).map((issuedAt) => ({ ...identity, issuedAt })));

// type は adapter より前に必ず見る。adapter から上書きさせない。
const ensureAppToken = (payload: JWTPayload): Result<JWTPayload, AccessJWTError> => {
  if (payload['type'] !== 'app') return err(new WrongAccessTokenType(payload['type']));

  return ok(payload);
};

export const createAccessJWTVerifier =
  <T>(toIdentity: AccessIdentityAdapter<T>) =>
  ({ token, teamDomain, aud, keys }: VerifyAccessJWTArgs): ResultAsync<T, AccessJWTError> =>
    ResultAsync.fromPromise(
      jwtVerify(token, keys, {
        // Access は RS256(RSA 2048)の鍵しか公開しないので選べない。
        // 固定しておくのは alg confusion(HS256 や none へのすり替え)を防ぐため。
        algorithms: ['RS256'],
        issuer: accessIssuer(teamDomain),
        audience: [...aud],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      }),
      (cause) => new InvalidAccessToken(cause),
    )
      .andThen(({ payload }) => ensureAppToken(payload))
      .andThen(toIdentity);

export const verifyAccessJWT = createAccessJWTVerifier(emailIdentity);
