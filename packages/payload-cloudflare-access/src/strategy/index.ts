import { errAsync, okAsync } from 'neverthrow';
import type { ResultAsync } from 'neverthrow';

import { isAllowedCookieRequest, isAllowedHeaderRequest } from '@napolab/cloudflare-access-core/csrf';
import { readFetchMetadata } from '@napolab/cloudflare-access-core/fetch-metadata';
import type { FetchMetadata } from '@napolab/cloudflare-access-core/fetch-metadata';
import { CrossSiteAccessRequest, ResolveUserError } from '../errors/index.js';
import type { AccessJWTError } from '@napolab/cloudflare-access-core/errors';
import type { AccessIdentityFetchFailed, InvalidAccessIdentity } from '@napolab/cloudflare-access-core/errors';
import type { AccessProfile, FetchAccessProfileArgs } from '@napolab/cloudflare-access-core/identity';
import { createPayloadProfileWriter, syncProfile, withProfileOnCreate } from '../profile-sync/index.js';
import type { AccessProfileMapper, ProfileSource } from '../profile-sync/index.js';
import { createPayloadUserStore, resolveAccessUser } from '../resolve-user/index.js';
import type { AccessUser } from '../resolve-user/index.js';
import { extractAccessToken } from '@napolab/cloudflare-access-core/token';
import type { AccessToken, AccessTokenSourceName } from '@napolab/cloudflare-access-core/token';
import { createAccessJWTVerifier, sessionIdentity, verifyAccessJWT } from '@napolab/cloudflare-access-core/verify';

import type { JWTVerifyGetKey } from 'jose';
import type { AuthStrategy, AuthStrategyResult, Payload, TypedUser } from 'payload';

// Payload は認証した strategy の名前を実行時の user._strategy に入れる(local-jwt / api-key など)。
export const ACCESS_STRATEGY_NAME = 'cloudflare-access';

export type AccessStrategyOptions = {
  teamDomain: string;
  aud: readonly string[];
  // Payload の結果型 (`AuthStrategyResult['user']`) は `TypedUser['collection']` を要求するので、それに合わせる。
  collection: TypedUser['collection'];
  keys: JWTVerifyGetKey;
  // 指定した時だけ get-identity を取りに行き、作成時と Access のセッションごとに user doc へ書く。
  profile?: AccessStrategyProfileOptions;
};

export type AccessStrategyProfileOptions = {
  map: AccessProfileMapper;
  fetchProfile: (args: Pick<FetchAccessProfileArgs, 'teamDomain' | 'token'>) => ResultAsync<AccessProfile, AccessIdentityFetchFailed | InvalidAccessIdentity>;
};

export type AuthenticatePayload = Pick<Payload, 'find' | 'create' | 'update' | 'config' | 'logger'>;

type AuthenticateArgs = { headers: Headers; payload: AuthenticatePayload };

type AccessFailure = CrossSiteAccessRequest | AccessJWTError | ResolveUserError;

const noUser = (): AuthStrategyResult => ({ user: null });

// header も cookie もブラウザが自動で送る CF_Authorization cookie が元なので、どちらにも CSRF 検査が要る。
// 経路ごとに正規のリクエストの形が違うので判定は分ける(@napolab/cloudflare-access-core/csrf)。拒否したら JWKS は取りに行かない。
const SAFE_ORIGIN_RULES = {
  header: isAllowedHeaderRequest,
  cookie: isAllowedCookieRequest,
} as const satisfies Record<AccessTokenSourceName, (request: FetchMetadata, csrf: readonly string[]) => boolean>;

const requireSafeOrigin = (accessToken: AccessToken, args: AuthenticateArgs): ResultAsync<AccessToken, CrossSiteAccessRequest> => {
  const isAllowed = SAFE_ORIGIN_RULES[accessToken.source];
  if (isAllowed(readFetchMetadata(args.headers), args.payload.config.csrf)) return okAsync(accessToken);

  return errAsync(new CrossSiteAccessRequest());
};

const authenticateEmail = (options: AccessStrategyOptions, args: AuthenticateArgs, token: string): ResultAsync<AccessUser, AccessFailure> =>
  verifyAccessJWT({ token, teamDomain: options.teamDomain, aud: options.aud, keys: options.keys }).andThen((identity) =>
    resolveAccessUser(createPayloadUserStore(args.payload, options.collection), identity),
  );

const verifySession = createAccessJWTVerifier(sessionIdentity);

// 認証の判定(verify / resolve)は authenticateEmail と同じ。プロフィール同期は失敗しても user を返す。
const authenticateWithProfile = (options: AccessStrategyOptions, profile: AccessStrategyProfileOptions, args: AuthenticateArgs, token: string): ResultAsync<AccessUser, AccessFailure> => {
  const source: ProfileSource = { map: profile.map, fetchProfile: () => profile.fetchProfile({ teamDomain: options.teamDomain, token }) };
  const store = withProfileOnCreate(createPayloadUserStore(args.payload, options.collection), source, args.payload.logger);
  const deps = { ...source, update: createPayloadProfileWriter(args.payload, options.collection), logger: args.payload.logger };

  return verifySession({ token, teamDomain: options.teamDomain, aud: options.aud, keys: options.keys }).andThen((identity) =>
    resolveAccessUser(store, identity).andThen((user) => syncProfile(deps, user, identity.issuedAt)),
  );
};

const authenticateToken = (options: AccessStrategyOptions, args: AuthenticateArgs, accessToken: AccessToken): ResultAsync<AccessUser, AccessFailure> =>
  requireSafeOrigin(accessToken, args).andThen(({ token }) =>
    options.profile === undefined ? authenticateEmail(options, args, token) : authenticateWithProfile(options, options.profile, args, token),
  );

// 失敗は拒否(token/csrf/verify)と運用障害(resolve)で重大度を分ける。strategy 自体は投げない。
const logFailure = (logger: AuthenticatePayload['logger'], source: AccessToken['source'], failure: AccessFailure): void => {
  if (failure instanceof ResolveUserError) {
    logger.error({ err: failure, source }, 'Cloudflare Access user resolution failed');
    return;
  }
  logger.warn({ err: failure, source }, 'Cloudflare Access authentication rejected');
};

export const authenticateAccess = async (options: AccessStrategyOptions, args: AuthenticateArgs): Promise<AuthStrategyResult> =>
  extractAccessToken(args.headers).match(
    (accessToken) =>
      authenticateToken(options, args, accessToken).match(
        (user): AuthStrategyResult => ({ user: { ...user, collection: options.collection, _strategy: ACCESS_STRATEGY_NAME } }),
        (failure): AuthStrategyResult => {
          logFailure(args.payload.logger, accessToken.source, failure);
          return noUser();
        },
      ),
    async () => noUser(),
  );

export const createAccessStrategy = (options: AccessStrategyOptions): AuthStrategy => ({
  name: ACCESS_STRATEGY_NAME,
  authenticate: (args) => authenticateAccess(options, args),
});
