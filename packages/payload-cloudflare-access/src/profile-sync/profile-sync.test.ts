import { errAsync, okAsync } from 'neverthrow';
import { describe, expect, test, vi } from 'vitest';

import { AccessIdentityFetchFailed } from '@napolab/cloudflare-access-core/errors';
import type { AccessProfile } from '@napolab/cloudflare-access-core/identity';
import { AccessProfileMapFailed, AccessProfileUpdateFailed } from '../errors/index.js';
import type { AccessUser, AccessUserData, UserStore } from '../resolve-user/index.js';
import { createPayloadProfileWriter, needsProfileSync, syncProfile, withProfileOnCreate } from './index.js';
import type { ProfileSource, ProfileSyncDeps } from './index.js';

const EMAIL = 'napo@example.com';
const LOGIN = new Date('2026-10-26T00:00:00.000Z');

const profile: AccessProfile = { email: EMAIL, name: 'napo', picture: 'https://example.com/napo.png', idp: { id: 'idp', type: 'google' } };

const mapProfile = (accessProfile: AccessProfile): AccessUserData => ({ displayName: accessProfile.name, avatarURL: accessProfile.picture });

const userUpdatedAt = (updatedAt: unknown): AccessUser => ({ id: 1, email: EMAIL, updatedAt, createdAt: '2026-10-01T00:00:00.000Z' });

const sourceOf = (overrides: Partial<ProfileSource> = {}): ProfileSource => ({
  fetchProfile: vi.fn(() => okAsync(profile)),
  map: vi.fn(mapProfile),
  ...overrides,
});

describe('needsProfileSync', () => {
  test('syncs when the Access login is newer than the last write', () => {
    expect(needsProfileSync({ issuedAt: LOGIN, updatedAt: '2026-10-25T23:59:59.000Z' })).toBe(true);
  });

  test('does not sync when the doc was written after the Access login', () => {
    expect(needsProfileSync({ issuedAt: LOGIN, updatedAt: '2026-10-26T00:00:01.000Z' })).toBe(false);
  });

  test('does not sync when the doc was written at the login time', () => {
    expect(needsProfileSync({ issuedAt: LOGIN, updatedAt: LOGIN.toISOString() })).toBe(false);
  });

  test.each([undefined, '', 'not a date'])('syncs when updatedAt is unknown (%j)', (updatedAt) => {
    expect(needsProfileSync({ issuedAt: LOGIN, updatedAt })).toBe(true);
  });
});

describe('withProfileOnCreate', () => {
  const storeOf = () => {
    const created = userUpdatedAt('2026-10-26T00:00:05.000Z');
    const inner = { findByEmail: vi.fn<UserStore['findByEmail']>(async () => undefined), create: vi.fn<UserStore['create']>(async () => created) };
    return { inner, created };
  };

  test('merges the mapped profile into the create data', async () => {
    const { inner, created } = storeOf();
    const logger = { warn: vi.fn() };

    const store = withProfileOnCreate(inner, sourceOf(), logger);

    await expect(store.create({ email: EMAIL })).resolves.toBe(created);
    expect(inner.create).toHaveBeenCalledWith({ displayName: 'napo', avatarURL: 'https://example.com/napo.png', email: EMAIL });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('the mapper cannot replace the email', async () => {
    const { inner } = storeOf();

    const store = withProfileOnCreate(inner, sourceOf({ map: () => ({ email: 'evil@example.com' }) }), { warn: vi.fn() });
    await store.create({ email: EMAIL });

    expect(inner.create).toHaveBeenCalledWith({ email: EMAIL });
  });

  test('creates without the profile and warns when the fetch fails', async () => {
    const { inner, created } = storeOf();
    const logger = { warn: vi.fn() };
    const failure = new AccessIdentityFetchFailed(500);

    const store = withProfileOnCreate(inner, sourceOf({ fetchProfile: () => errAsync(failure) }), logger);

    await expect(store.create({ email: EMAIL })).resolves.toBe(created);
    expect(inner.create).toHaveBeenCalledWith({ email: EMAIL });
    expect(logger.warn).toHaveBeenCalledWith({ err: failure }, 'Cloudflare Access profile could not be loaded; creating the user without it');
  });

  test('creates without the profile and warns when the mapper throws', async () => {
    const { inner } = storeOf();
    const logger = { warn: vi.fn() };
    const cause = new Error('bad mapper');

    const store = withProfileOnCreate(
      inner,
      sourceOf({
        map: () => {
          throw cause;
        },
      }),
      logger,
    );
    await store.create({ email: EMAIL });

    expect(inner.create).toHaveBeenCalledWith({ email: EMAIL });
    const err = logger.warn.mock.calls[0]?.[0].err;
    expect(err).toBeInstanceOf(AccessProfileMapFailed);
    expect(err.cause).toBe(cause);
  });

  test('keeps findByEmail as is', () => {
    const { inner } = storeOf();

    expect(withProfileOnCreate(inner, sourceOf(), { warn: vi.fn() }).findByEmail).toBe(inner.findByEmail);
  });

  test('lets a failed create reject as before', async () => {
    const { inner } = storeOf();
    const cause = new Error('duplicate email');
    inner.create.mockRejectedValue(cause);

    await expect(withProfileOnCreate(inner, sourceOf(), { warn: vi.fn() }).create({ email: EMAIL })).rejects.toBe(cause);
  });
});

describe('syncProfile', () => {
  const depsOf = (overrides: Partial<Omit<ProfileSyncDeps, 'logger'>> = {}) => {
    const updated = userUpdatedAt('2026-10-26T00:00:05.000Z');
    const deps = {
      ...sourceOf(),
      update: vi.fn<ProfileSyncDeps['update']>(async () => updated),
      ...overrides,
      logger: { warn: vi.fn() },
    };
    return { deps, updated };
  };

  test('returns the user untouched when the doc is newer than the login', async () => {
    const { deps } = depsOf();
    const user = userUpdatedAt('2026-10-26T00:00:01.000Z');

    const result = await syncProfile(deps, user, LOGIN);

    expect(result._unsafeUnwrap()).toBe(user);
    expect(deps.fetchProfile).not.toHaveBeenCalled();
    expect(deps.update).not.toHaveBeenCalled();
  });

  test('writes the mapped profile and returns the updated user on a new Access session', async () => {
    const { deps, updated } = depsOf();

    const result = await syncProfile(deps, userUpdatedAt('2026-10-01T00:00:00.000Z'), LOGIN);

    expect(result._unsafeUnwrap()).toBe(updated);
    expect(deps.update).toHaveBeenCalledWith(1, { displayName: 'napo', avatarURL: 'https://example.com/napo.png' });
  });

  // 書かないと updatedAt が iat を越えず、同じセッションの毎リクエストで取りに行ってしまう。
  test('writes even when the mapper returns nothing', async () => {
    const { deps } = depsOf({ map: () => ({}) });

    await syncProfile(deps, userUpdatedAt(undefined), LOGIN);

    expect(deps.update).toHaveBeenCalledWith(1, {});
  });

  test('returns the user and warns when the fetch fails', async () => {
    const failure = new AccessIdentityFetchFailed(undefined, new TypeError('network'));
    const { deps } = depsOf({ fetchProfile: () => errAsync(failure) });
    const user = userUpdatedAt(undefined);

    const result = await syncProfile(deps, user, LOGIN);

    expect(result._unsafeUnwrap()).toBe(user);
    expect(deps.update).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith({ err: failure }, 'Cloudflare Access profile sync failed');
  });

  test('returns the user and warns when the mapper throws', async () => {
    const { deps } = depsOf({
      map: () => {
        throw new Error('bad mapper');
      },
    });
    const user = userUpdatedAt(undefined);

    const result = await syncProfile(deps, user, LOGIN);

    expect(result._unsafeUnwrap()).toBe(user);
    expect(deps.update).not.toHaveBeenCalled();
    expect(deps.logger.warn.mock.calls[0]?.[0].err).toBeInstanceOf(AccessProfileMapFailed);
  });

  test('returns the user and warns when the update fails', async () => {
    const cause = new Error('db down');
    const { deps } = depsOf({
      update: async () => {
        throw cause;
      },
    });
    const user = userUpdatedAt(undefined);

    const result = await syncProfile(deps, user, LOGIN);

    expect(result._unsafeUnwrap()).toBe(user);
    const err = deps.logger.warn.mock.calls[0]?.[0].err;
    expect(err).toBeInstanceOf(AccessProfileUpdateFailed);
    expect(err.cause).toBe(cause);
  });
});

describe('createPayloadProfileWriter', () => {
  test('updates the user by id with overrideAccess and returns the doc', async () => {
    const updated = userUpdatedAt('2026-10-26T00:00:05.000Z');
    const update = vi.fn().mockResolvedValue(updated);

    const write = createPayloadProfileWriter({ update }, 'users');

    await expect(write(1, { displayName: 'napo' })).resolves.toBe(updated);
    expect(update).toHaveBeenCalledWith({ collection: 'users', id: 1, data: { displayName: 'napo' }, depth: 0, overrideAccess: true });
  });

  test('rejects a doc that is not an auth user', async () => {
    const write = createPayloadProfileWriter({ update: vi.fn().mockResolvedValue({ id: 1 }) }, 'users');

    await expect(write(1, {})).rejects.toThrow(TypeError);
  });
});
