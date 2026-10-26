import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import type { JWK, JWTVerifyGetKey, KeyObject } from 'jose';
import { errAsync, okAsync } from 'neverthrow';
import { beforeAll, describe, expect, test, vi } from 'vitest';

import { AccessIdentityFetchFailed } from '@napolab/cloudflare-access-core/errors';
import type { AccessProfile } from '@napolab/cloudflare-access-core/identity';

import { CrossSiteAccessRequest } from '../errors/index.js';
import { accessIssuer } from '@napolab/cloudflare-access-core/verify';
import { ACCESS_STRATEGY_NAME, authenticateAccess, createAccessStrategy } from './index.js';
import type { AccessStrategyOptions, AuthenticatePayload } from './index.js';

const TEAM = 'napolab';
const KID = 'test-key';
const EMAIL = 'napo@example.com';
const NOW_SECONDS = () => Math.floor(Date.now() / 1000);
const CSRF = ['https://napochaan.com'];

type Fixture = { privateKey: CryptoKey | KeyObject; keys: JWTVerifyGetKey };

const createFixture = async (): Promise<Fixture> => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256' };
  return { privateKey, keys: createLocalJWKSet({ keys: [jwk] }) };
};

const storedUser = { id: 1, email: EMAIL, updatedAt: '2026-10-05T00:00:00.000Z', createdAt: '2026-10-05T00:00:00.000Z' };
const syncedUser = { ...storedUser, displayName: 'napo', updatedAt: new Date().toISOString() };

type TestPayload = AuthenticatePayload & {
  find: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
};

// find / create / logger は Pick<Payload, ...> のうち strategy が触る分だけの最小実装。
const createPayload = (find: () => Promise<unknown> = async () => ({ docs: [storedUser] })): TestPayload => {
  const payload = {
    find: vi.fn(find),
    create: vi.fn(async () => storedUser),
    update: vi.fn(async () => syncedUser),
    config: { csrf: CSRF },
    logger: { warn: vi.fn(), error: vi.fn() },
  };
  return payload as unknown as TestPayload;
};

describe('authenticateAccess', () => {
  const fixture: { current?: Fixture } = {};

  beforeAll(async () => {
    fixture.current = await createFixture();
  });

  const getFixture = (): Fixture => {
    if (fixture.current === undefined) throw new Error('fixture is not ready');
    return fixture.current;
  };

  const sign = async (audience = 'aud-1'): Promise<string> =>
    new SignJWT({ type: 'app', email: EMAIL })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(accessIssuer(TEAM))
      .setAudience(audience)
      .setExpirationTime(NOW_SECONDS() + 300)
      .setNotBefore(NOW_SECONDS() - 10)
      .sign(getFixture().privateKey);

  // Access は iat(ログイン時刻)を必ず付ける。profile 同期はこれと doc の updatedAt を比べる。
  const signSession = async (issuedAt: number): Promise<string> =>
    new SignJWT({ type: 'app', email: EMAIL })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(accessIssuer(TEAM))
      .setAudience('aud-1')
      .setIssuedAt(issuedAt)
      .setExpirationTime(NOW_SECONDS() + 300)
      .sign(getFixture().privateKey);

  const optionsWith = (keys: JWTVerifyGetKey = getFixture().keys): AccessStrategyOptions => ({ teamDomain: TEAM, aud: ['aud-1'], collection: 'users', keys });

  test('does not resolve keys without a token', async () => {
    const keys = vi.fn<JWTVerifyGetKey>(() => {
      throw new Error('keys must not be resolved without a token');
    });

    const result = await authenticateAccess(optionsWith(keys), { headers: new Headers(), payload: createPayload() });

    expect(result).toEqual({ user: null });
    expect(keys).not.toHaveBeenCalled();
  });

  test('authenticates via the header', async () => {
    const headers = new Headers({ 'Cf-Access-Jwt-Assertion': await sign() });

    const result = await authenticateAccess(optionsWith(), { headers, payload: createPayload() });

    expect(result.user?.email).toBe(EMAIL);
    expect(result.user?.collection).toBe('users');
    expect(result.user?._strategy).toBe('cloudflare-access');
  });

  test('authenticates via the cookie from the same origin', async () => {
    const headers = new Headers({ cookie: `CF_Authorization=${await sign()}`, 'Sec-Fetch-Site': 'same-origin' });

    const result = await authenticateAccess(optionsWith(), { headers, payload: createPayload() });

    expect(result.user?.email).toBe(EMAIL);
  });

  test('rejects cross-site cookie request', async () => {
    const keys = vi.fn<JWTVerifyGetKey>(() => {
      throw new Error('keys must not be resolved for a rejected cookie request');
    });
    const payload = createPayload();
    const headers = new Headers({ cookie: `CF_Authorization=${await sign()}`, Origin: 'https://evil.example' });

    const result = await authenticateAccess(optionsWith(keys), { headers, payload });

    expect(result).toEqual({ user: null });
    expect(payload.logger.warn).toHaveBeenCalledTimes(1);
    expect(payload.logger.warn).toHaveBeenCalledWith({ err: expect.any(CrossSiteAccessRequest), source: 'cookie' }, 'Cloudflare Access authentication rejected');
    expect(keys).not.toHaveBeenCalled();
  });

  // Access は header をブラウザの CF_Authorization cookie から付けるので、header 由来でもクロスサイト要求を拒否する。
  test.each<{ name: string; metadata: Record<string, string> }>([
    { name: 'a cross-site Origin', metadata: { Origin: 'https://evil.example' } },
    { name: 'a cross-site <img> subresource', metadata: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'image' } },
  ])('rejects a header token on $name without resolving keys', async ({ metadata }) => {
    const keys = vi.fn<JWTVerifyGetKey>(() => {
      throw new Error('keys must not be resolved for a rejected header request');
    });
    const payload = createPayload();
    const headers = new Headers({ 'Cf-Access-Jwt-Assertion': await sign(), ...metadata });

    const result = await authenticateAccess(optionsWith(keys), { headers, payload });

    expect(result).toEqual({ user: null });
    expect(payload.logger.warn).toHaveBeenCalledTimes(1);
    expect(payload.logger.warn).toHaveBeenCalledWith({ err: expect.any(CrossSiteAccessRequest), source: 'header' }, 'Cloudflare Access authentication rejected');
    expect(keys).not.toHaveBeenCalled();
  });

  test('authenticates a header token on a top-level cross-site navigation (Access login landing)', async () => {
    const headers = new Headers({ 'Cf-Access-Jwt-Assertion': await sign(), 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });

    const result = await authenticateAccess(optionsWith(), { headers, payload: createPayload() });

    expect(result.user?.email).toBe(EMAIL);
  });

  test('returns null for an invalid token without throwing', async () => {
    const payload = createPayload();
    const headers = new Headers({ 'Cf-Access-Jwt-Assertion': await sign('other-aud') });

    const result = await authenticateAccess(optionsWith(), { headers, payload });

    expect(result).toEqual({ user: null });
    expect(payload.logger.warn).toHaveBeenCalledTimes(1);
  });

  test('does not fetch the profile or update the user without the profile option', async () => {
    const payload = createPayload();
    const headers = new Headers({ 'Cf-Access-Jwt-Assertion': await sign() });

    await authenticateAccess(optionsWith(), { headers, payload });

    expect(payload.update).not.toHaveBeenCalled();
  });

  test('returns null when user resolution fails', async () => {
    const payload = createPayload(async () => {
      throw new Error('database is down');
    });
    const headers = new Headers({ 'Cf-Access-Jwt-Assertion': await sign() });

    const result = await authenticateAccess(optionsWith(), { headers, payload });

    expect(result).toEqual({ user: null });
    expect(payload.logger.error).toHaveBeenCalledTimes(1);
  });

  describe('with profile sync', () => {
    const profile: AccessProfile = { email: EMAIL, name: 'napo', picture: 'https://example.com/napo.png', idp: undefined };
    const map = (accessProfile: AccessProfile) => ({ displayName: accessProfile.name });

    const profileOptions = (fetchProfile: NonNullable<AccessStrategyOptions['profile']>['fetchProfile'] = vi.fn(() => okAsync(profile))): AccessStrategyOptions => ({
      ...optionsWith(),
      profile: { map, fetchProfile },
    });

    // storedUser.updatedAt(2026-10-05)より後のログイン。
    const newSession = () => NOW_SECONDS() - 60;

    test('syncs the profile once per Access session and returns the updated user', async () => {
      const fetchProfile = vi.fn(() => okAsync(profile));
      const payload = createPayload();
      const token = await signSession(newSession());
      const headers = new Headers({ 'Cf-Access-Jwt-Assertion': token });

      const result = await authenticateAccess(profileOptions(fetchProfile), { headers, payload });

      expect(fetchProfile).toHaveBeenCalledWith({ teamDomain: TEAM, token });
      expect(payload.update).toHaveBeenCalledWith({ collection: 'users', id: 1, data: { displayName: 'napo' }, depth: 0, overrideAccess: true });
      expect(result.user).toMatchObject({ displayName: 'napo', collection: 'users', _strategy: 'cloudflare-access' });
    });

    test('does not fetch when the user was written after the Access login', async () => {
      const fetchProfile = vi.fn(() => okAsync(profile));
      const payload = createPayload();
      const headers = new Headers({ 'Cf-Access-Jwt-Assertion': await signSession(Date.parse('2026-10-04T00:00:00.000Z') / 1000) });

      const result = await authenticateAccess(profileOptions(fetchProfile), { headers, payload });

      expect(result.user?.email).toBe(EMAIL);
      expect(fetchProfile).not.toHaveBeenCalled();
      expect(payload.update).not.toHaveBeenCalled();
    });

    test('creates a new user with the mapped profile', async () => {
      const payload = createPayload(async () => ({ docs: [] }));
      payload.create.mockResolvedValue(syncedUser);
      const headers = new Headers({ 'Cf-Access-Jwt-Assertion': await signSession(newSession()) });

      const result = await authenticateAccess(profileOptions(), { headers, payload });

      expect(payload.create).toHaveBeenCalledWith({ collection: 'users', data: { displayName: 'napo', email: EMAIL }, overrideAccess: true });
      expect(payload.update).not.toHaveBeenCalled();
      expect(result.user?.email).toBe(EMAIL);
    });

    test('still authenticates and warns when the profile fetch fails', async () => {
      const failure = new AccessIdentityFetchFailed(500);
      const payload = createPayload();
      const headers = new Headers({ 'Cf-Access-Jwt-Assertion': await signSession(newSession()) });

      const result = await authenticateAccess(
        profileOptions(() => errAsync(failure)),
        { headers, payload },
      );

      expect(result.user).toMatchObject({ email: EMAIL, updatedAt: storedUser.updatedAt });
      expect(payload.logger.warn).toHaveBeenCalledWith({ err: failure }, 'Cloudflare Access profile sync failed');
    });

    test('still authenticates when the update fails', async () => {
      const payload = createPayload();
      payload.update.mockRejectedValue(new Error('db down'));
      const headers = new Headers({ 'Cf-Access-Jwt-Assertion': await signSession(newSession()) });

      const result = await authenticateAccess(profileOptions(), { headers, payload });

      expect(result.user?.email).toBe(EMAIL);
      expect(payload.logger.warn).toHaveBeenCalledTimes(1);
    });

    test('rejects a token without iat', async () => {
      const payload = createPayload();
      const headers = new Headers({ 'Cf-Access-Jwt-Assertion': await sign() });

      const result = await authenticateAccess(profileOptions(), { headers, payload });

      expect(result).toEqual({ user: null });
      expect(payload.find).not.toHaveBeenCalled();
    });
  });
});

describe('createAccessStrategy', () => {
  test('is named cloudflare-access', () => {
    const strategy = createAccessStrategy({ teamDomain: TEAM, aud: ['aud-1'], collection: 'users', keys: createLocalJWKSet({ keys: [] }) });

    expect(strategy.name).toBe(ACCESS_STRATEGY_NAME);
    expect(ACCESS_STRATEGY_NAME).toBe('cloudflare-access');
  });
});
