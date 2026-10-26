import { okAsync, Result, ResultAsync } from 'neverthrow';

import type { AccessIdentityFetchFailed, InvalidAccessIdentity } from '@napolab/cloudflare-access-core/errors';
import type { AccessProfile } from '@napolab/cloudflare-access-core/identity';
import { AccessProfileMapFailed, AccessProfileUpdateFailed } from '../errors/index.js';
import { toAccessUser } from '../resolve-user/index.js';
import type { AccessUser, AccessUserCreateData, AccessUserData, UserStore } from '../resolve-user/index.js';

import type { Payload, TypedUser } from 'payload';

// AccessProfile から user doc に書くデータを作る。plugin はフィールドを足さないので、利用側のフィールドだけ返す。
export type AccessProfileMapper = (profile: AccessProfile) => AccessUserData;

export type ProfileSource = {
  fetchProfile: () => ResultAsync<AccessProfile, AccessIdentityFetchFailed | InvalidAccessIdentity>;
  map: AccessProfileMapper;
};

// pino の logger.warn がそのまま入る最小の形。
export type ProfileSyncLogger = { warn: (details: { err: Error }, message: string) => void };

export type ProfileSyncDeps = ProfileSource & {
  update: (id: AccessUser['id'], data: AccessUserData) => Promise<AccessUser>;
  logger: ProfileSyncLogger;
};

type ProfileLoadFailure = AccessIdentityFetchFailed | InvalidAccessIdentity | AccessProfileMapFailed;

type ProfileSyncFailure = ProfileLoadFailure | AccessProfileUpdateFailed;

type SyncTiming = { issuedAt: Date; updatedAt: string | undefined };

// Access のログイン(iat)より後に doc を書いていれば、そのセッションでは同期済み。
// updatedAt が無い / 読めない時は同期する(同期後は必ず書くので updatedAt が iat を越える)。
export const needsProfileSync = ({ issuedAt, updatedAt }: SyncTiming): boolean => {
  if (updatedAt === undefined) return true;

  const written = Date.parse(updatedAt);
  if (Number.isNaN(written)) return true;

  return issuedAt.getTime() > written;
};

const readUpdatedAt = (user: AccessUser): string | undefined => ('updatedAt' in user && typeof user.updatedAt === 'string' ? user.updatedAt : undefined);

const mapProfile = (map: AccessProfileMapper, profile: AccessProfile): Result<AccessUserData, AccessProfileMapFailed> =>
  Result.fromThrowable(map, (cause) => new AccessProfileMapFailed(cause))(profile);

const loadProfileData = ({ fetchProfile, map }: ProfileSource): ResultAsync<AccessUserData, ProfileLoadFailure> => fetchProfile().andThen((profile) => mapProfile(map, profile));

// email は Access の identity が正。mapper が返しても上書きさせない。
const withCreateData = (source: ProfileSource, logger: ProfileSyncLogger, data: AccessUserCreateData): Promise<AccessUserCreateData> =>
  loadProfileData(source).match(
    (profileData) => ({ ...profileData, ...data }),
    (failure) => {
      logger.warn({ err: failure }, 'Cloudflare Access profile could not be loaded; creating the user without it');
      return data;
    },
  );

// 自動作成の時だけ、作成データにプロフィールを混ぜる。取れなければプロフィール無しで今まで通り作る。
export const withProfileOnCreate = (store: UserStore, source: ProfileSource, logger: ProfileSyncLogger): UserStore => ({
  findByEmail: store.findByEmail,
  create: async (data) => store.create(await withCreateData(source, logger, data)),
});

const writeProfile = (update: ProfileSyncDeps['update'], id: AccessUser['id'], data: AccessUserData): ResultAsync<AccessUser, AccessProfileUpdateFailed> =>
  ResultAsync.fromPromise(update(id, data), (cause) => new AccessProfileUpdateFailed(cause));

// Access のセッションごとに 1 回、プロフィールを書き直す。失敗しても認証は落とさず、元の user を返す。
export const syncProfile = (deps: ProfileSyncDeps, user: AccessUser, issuedAt: Date): ResultAsync<AccessUser, never> => {
  if (!needsProfileSync({ issuedAt, updatedAt: readUpdatedAt(user) })) return okAsync(user);

  return loadProfileData(deps)
    .andThen((data) => writeProfile(deps.update, user.id, data))
    .orElse((failure: ProfileSyncFailure) => {
      deps.logger.warn({ err: failure }, 'Cloudflare Access profile sync failed');
      return okAsync(user);
    });
};

export const createPayloadProfileWriter =
  (payload: Pick<Payload, 'update'>, collection: TypedUser['collection']): ProfileSyncDeps['update'] =>
  async (id, data) =>
    toAccessUser(await payload.update({ collection, id, data, depth: 0, overrideAccess: true }));
