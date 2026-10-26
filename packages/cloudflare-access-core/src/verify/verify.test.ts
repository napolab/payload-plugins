import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import type { JWK, JWTPayload, JWTVerifyGetKey, KeyObject } from 'jose';
import { err, ok } from 'neverthrow';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { InvalidAccessClaims, InvalidAccessToken, MissingAccessEmail, WrongAccessTokenType } from '../errors/index.js';
import { accessIssuer, createAccessJWTVerifier, sessionIdentity, verifyAccessJWT } from './index.js';
import type { AccessIdentityAdapter } from './index.js';

const TEAM = 'napolab';
const KID = 'test-key';
const NOW_SECONDS = () => Math.floor(Date.now() / 1000);

type SignOptions = {
  audience?: string;
  issuer?: string;
  expiresAt?: number;
  notBefore?: number;
  privateKey?: CryptoKey | KeyObject | Uint8Array;
  alg?: 'RS256' | 'HS256';
};

type Fixture = {
  privateKey: CryptoKey | KeyObject;
  otherPrivateKey: CryptoKey | KeyObject;
  keys: JWTVerifyGetKey;
};

const createFixture = async (): Promise<Fixture> => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const other = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: KID, alg: 'RS256' };
  return { privateKey, otherPrivateKey: other.privateKey, keys: createLocalJWKSet({ keys: [jwk] }) };
};

describe('verifyAccessJWT', () => {
  const fixture: { current?: Fixture } = {};

  beforeAll(async () => {
    fixture.current = await createFixture();
  });

  const getFixture = (): Fixture => {
    if (fixture.current === undefined) throw new Error('fixture is not ready');
    return fixture.current;
  };

  const sign = async (claims: Record<string, unknown>, options: SignOptions = {}): Promise<string> => {
    const alg = options.alg ?? 'RS256';
    const key = options.privateKey ?? getFixture().privateKey;
    return new SignJWT(claims)
      .setProtectedHeader({ alg, kid: KID })
      .setIssuer(options.issuer ?? accessIssuer(TEAM))
      .setAudience(options.audience ?? 'aud-1')
      .setExpirationTime(options.expiresAt ?? NOW_SECONDS() + 300)
      .setNotBefore(options.notBefore ?? NOW_SECONDS() - 10)
      .sign(key);
  };

  const verify = (token: string, aud: readonly string[] = ['aud-1']) => verifyAccessJWT({ token, teamDomain: TEAM, aud, keys: getFixture().keys });

  const appClaims = { type: 'app', email: 'napo@example.com' };

  it('returns the email of a valid app token', async () => {
    const result = await verify(await sign(appClaims));

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ email: 'napo@example.com' });
  });

  it('accepts any listed audience', async () => {
    const result = await verify(await sign(appClaims, { audience: 'aud-2' }), ['aud-1', 'aud-2']);

    expect(result.isOk()).toBe(true);
  });

  it('rejects an expired token', async () => {
    const result = await verify(await sign(appClaims, { expiresAt: NOW_SECONDS() - 60 }));

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidAccessToken);
  });

  it('tolerates 30 seconds of clock skew', async () => {
    const result = await verify(await sign(appClaims, { expiresAt: NOW_SECONDS() - 10 }));

    expect(result.isOk()).toBe(true);
  });

  it('rejects a token that is not yet valid', async () => {
    const result = await verify(await sign(appClaims, { notBefore: NOW_SECONDS() + 60 }));

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidAccessToken);
  });

  it('rejects a wrong audience', async () => {
    const result = await verify(await sign(appClaims, { audience: 'other' }));

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidAccessToken);
  });

  it('rejects a wrong issuer', async () => {
    const result = await verify(await sign(appClaims, { issuer: 'https://evil.cloudflareaccess.com' }));

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidAccessToken);
  });

  it('rejects a tampered signature', async () => {
    const result = await verify(await sign(appClaims, { privateKey: getFixture().otherPrivateKey }));

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidAccessToken);
  });

  it('rejects a non-RS256 token', async () => {
    const secret = new TextEncoder().encode('0123456789abcdef0123456789abcdef');
    const result = await verify(await sign(appClaims, { alg: 'HS256', privateKey: secret }));

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidAccessToken);
  });

  it('keeps the jose failure as the cause of InvalidAccessToken', async () => {
    const result = await verify(await sign(appClaims, { audience: 'other' }));

    expect(result._unsafeUnwrapErr().cause).toBeInstanceOf(Error);
  });

  it('rejects a non-app token', async () => {
    const result = await verify(await sign({ type: 'org', email: 'napo@example.com' }));

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(WrongAccessTokenType);
  });

  it('rejects a service token without email', async () => {
    const result = await verify(await sign({ type: 'app', common_name: 'svc' }));

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(MissingAccessEmail);
  });

  it('rejects an empty email', async () => {
    const result = await verify(await sign({ type: 'app', email: '' }));

    expect(result._unsafeUnwrapErr()).toBeInstanceOf(MissingAccessEmail);
  });
  describe('createAccessJWTVerifier', () => {
    type Groups = { groups: readonly string[] };

    const isStringArray = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

    const groupsIdentity: AccessIdentityAdapter<Groups> = (payload: JWTPayload) => {
      const custom = payload['custom'];
      if (typeof custom !== 'object' || custom === null || !('groups' in custom)) return err(new InvalidAccessClaims('custom.groups'));
      if (!isStringArray(custom.groups)) return err(new InvalidAccessClaims('custom.groups'));

      return ok({ groups: custom.groups });
    };

    const verifyWith = <T>(adapter: AccessIdentityAdapter<T>, token: string) => createAccessJWTVerifier(adapter)({ token, teamDomain: TEAM, aud: ['aud-1'], keys: getFixture().keys });

    it('returns what the adapter builds from the custom claim', async () => {
      const result = await verifyWith(groupsIdentity, await sign({ type: 'app', custom: { groups: ['admin', 'editor'] } }));

      expect(result._unsafeUnwrap()).toEqual({ groups: ['admin', 'editor'] });
    });

    it('propagates the adapter error', async () => {
      const result = await verifyWith(groupsIdentity, await sign({ type: 'app', custom: { groups: 'admin' } }));
      const error = result._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(InvalidAccessClaims);
      expect(error.message).toContain('custom.groups');
    });

    it('does not call the adapter for a non-app token', async () => {
      const adapter = vi.fn(groupsIdentity);
      const result = await verifyWith(adapter, await sign({ type: 'org', custom: { groups: ['admin'] } }));

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(WrongAccessTokenType);
      expect(adapter).not.toHaveBeenCalled();
    });

    it('does not call the adapter for a token that fails verification', async () => {
      const adapter = vi.fn(groupsIdentity);
      const result = await verifyWith(adapter, await sign({ type: 'app', custom: { groups: ['admin'] } }, { audience: 'other' }));

      expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidAccessToken);
      expect(adapter).not.toHaveBeenCalled();
    });
  });

  describe('sessionIdentity', () => {
    const verifySession = (token: string) => createAccessJWTVerifier(sessionIdentity)({ token, teamDomain: TEAM, aud: ['aud-1'], keys: getFixture().keys });

    const signWithIssuedAt = async (claims: Record<string, unknown>, iat: number): Promise<string> =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(accessIssuer(TEAM))
        .setAudience('aud-1')
        .setIssuedAt(iat)
        .setExpirationTime(NOW_SECONDS() + 300)
        .sign(getFixture().privateKey);

    it('returns the email and the Access login time from iat', async () => {
      const iat = NOW_SECONDS() - 120;

      const result = await verifySession(await signWithIssuedAt(appClaims, iat));

      expect(result._unsafeUnwrap()).toEqual({ email: 'napo@example.com', issuedAt: new Date(iat * 1000) });
    });

    it('rejects a token without iat', async () => {
      const error = (await verifySession(await sign(appClaims)))._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(InvalidAccessClaims);
      expect(error.message).toContain('"iat"');
    });

    // 文字列の iat などは jose が先に弾くので、adapter を直接呼んで確かめる。
    it.each<unknown>(['1790000000', null, Number.NaN, Number.POSITIVE_INFINITY])('rejects a non-finite or non-numeric iat (%j)', (iat) => {
      const error = sessionIdentity({ ...appClaims, iat } as JWTPayload)._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(InvalidAccessClaims);
    });

    it('rejects a token without email before reading iat', async () => {
      const error = (await verifySession(await signWithIssuedAt({ type: 'app' }, NOW_SECONDS())))._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(MissingAccessEmail);
    });
  });
});
