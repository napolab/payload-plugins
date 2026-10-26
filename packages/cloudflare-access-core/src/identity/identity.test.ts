import { describe, expect, it, vi } from 'vitest';

import { AccessIdentityFetchFailed, InvalidAccessIdentity } from '../errors/index.js';
import { fetchAccessProfile, identityURL, toAccessProfile } from './index.js';

// 実際の get-identity 応答(Google IdP)と同じ形。値は架空。使わないフィールドも混ぜておく。
const identityFixture = {
  id: 'identity-id',
  name: 'napo (なぽ)',
  email: 'napo@example.com',
  user_uuid: '00000000-0000-0000-0000-000000000000',
  account_id: 'account-id',
  iat: 1_790_000_000,
  ip: '203.0.113.1',
  auth_status: 'NONE',
  common_name: '',
  service_token_id: '',
  service_token_status: false,
  is_warp: false,
  is_gateway: false,
  geo: { country: 'JP' },
  device_sessions: {},
  version: 2,
  idp: { id: 'idp-id', type: 'google' },
  oidc_fields: {
    name: 'napo oidc',
    given_name: 'napo',
    picture: 'https://lh3.googleusercontent.com/a/picture=s96-c',
  },
};

const withOIDC = (fields: object) => ({ ...identityFixture, oidc_fields: { ...identityFixture.oidc_fields, ...fields } });

describe('identityURL', () => {
  it('points at the team get-identity endpoint', () => {
    expect(identityURL('napolab')).toBe('https://napolab.cloudflareaccess.com/cdn-cgi/access/get-identity');
  });
});

describe('toAccessProfile', () => {
  it('reads email, name, picture and idp from a real-shaped response', () => {
    expect(toAccessProfile(identityFixture)._unsafeUnwrap()).toEqual({
      email: 'napo@example.com',
      name: 'napo (なぽ)',
      picture: 'https://lh3.googleusercontent.com/a/picture=s96-c',
      idp: { id: 'idp-id', type: 'google' },
    });
  });

  it.each([{ email: undefined }, { email: '' }, { email: 1 }])('fails without a usable email (%j)', (patch) => {
    const error = toAccessProfile({ ...identityFixture, ...patch })._unsafeUnwrapErr();

    expect(error).toBeInstanceOf(InvalidAccessIdentity);
    expect(error.reason).toBe('email');
  });

  it.each([null, 'text', 1, []])('fails for a non-object body (%j)', (body) => {
    expect(toAccessProfile(body)._unsafeUnwrapErr()).toBeInstanceOf(InvalidAccessIdentity);
  });

  it('trims the name', () => {
    expect(toAccessProfile({ ...identityFixture, name: '  napo  ' })._unsafeUnwrap().name).toBe('napo');
  });

  it.each([{ name: undefined }, { name: '   ' }, { name: 1 }])('falls back to oidc_fields.name (%j)', (patch) => {
    expect(toAccessProfile({ ...identityFixture, ...patch })._unsafeUnwrap().name).toBe('napo oidc');
  });

  it('has no name when neither is usable', () => {
    const body = { ...withOIDC({ name: ' ' }), name: '' };

    expect(toAccessProfile(body)._unsafeUnwrap().name).toBeUndefined();
  });

  it.each([
    { picture: undefined },
    { picture: '' },
    { picture: 1 },
    { picture: 'not a url' },
    { picture: 'http://lh3.googleusercontent.com/a/picture' },
    { picture: 'javascript:alert(1)' },
    { picture: 'data:image/png;base64,AAAA' },
  ])('drops a picture that is not an https URL (%j)', (patch) => {
    expect(toAccessProfile(withOIDC(patch))._unsafeUnwrap().picture).toBeUndefined();
  });

  it('works without oidc_fields', () => {
    const { oidc_fields: _omitted, ...body } = identityFixture;

    expect(toAccessProfile(body)._unsafeUnwrap()).toEqual({ email: 'napo@example.com', name: 'napo (なぽ)', picture: undefined, idp: { id: 'idp-id', type: 'google' } });
  });

  it.each([{ idp: undefined }, { idp: { id: 'idp-id' } }, { idp: { id: 1, type: 'google' } }, { idp: 'google' }])('has no idp when it is malformed (%j)', (patch) => {
    expect(toAccessProfile({ ...identityFixture, ...patch })._unsafeUnwrap().idp).toBeUndefined();
  });

  it('ignores inherited properties', () => {
    const body = Object.create({ email: 'proto@example.com' });

    expect(toAccessProfile(body)._unsafeUnwrapErr()).toBeInstanceOf(InvalidAccessIdentity);
  });
});

describe('fetchAccessProfile', () => {
  const jsonResponse = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });

  it('sends the token as the CF_Authorization cookie without following redirects', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(identityFixture));

    const result = await fetchAccessProfile({ teamDomain: 'napolab', token: 'header.payload.signature', fetch });

    expect(result._unsafeUnwrap().email).toBe('napo@example.com');
    expect(fetch).toHaveBeenCalledWith('https://napolab.cloudflareaccess.com/cdn-cgi/access/get-identity', {
      headers: { cookie: 'CF_Authorization=header.payload.signature' },
      redirect: 'manual',
    });
  });

  it.each([302, 401, 500])('fails with the status for a %i response', async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status }));

    const error = (await fetchAccessProfile({ teamDomain: 'napolab', token: 't', fetch }))._unsafeUnwrapErr();

    expect(error).toBeInstanceOf(AccessIdentityFetchFailed);
    expect(error instanceof AccessIdentityFetchFailed ? error.status : 'not fetch failed').toBe(status);
  });

  it('fails without a status when fetch rejects', async () => {
    const cause = new TypeError('network down');
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw cause;
    });

    const error = (await fetchAccessProfile({ teamDomain: 'napolab', token: 't', fetch }))._unsafeUnwrapErr();

    expect(error).toBeInstanceOf(AccessIdentityFetchFailed);
    expect(error instanceof AccessIdentityFetchFailed ? error.status : 'not fetch failed').toBeUndefined();
    expect(error.cause).toBe(cause);
  });

  it('fails as invalid identity when the body is not JSON', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('<html>login</html>', { status: 200 }));

    const error = (await fetchAccessProfile({ teamDomain: 'napolab', token: 't', fetch }))._unsafeUnwrapErr();

    expect(error).toBeInstanceOf(InvalidAccessIdentity);
  });

  it('fails as invalid identity when the body has no email', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ name: 'napo' }));

    expect((await fetchAccessProfile({ teamDomain: 'napolab', token: 't', fetch }))._unsafeUnwrapErr()).toBeInstanceOf(InvalidAccessIdentity);
  });

  it('uses globalThis.fetch by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(identityFixture));

    try {
      const result = await fetchAccessProfile({ teamDomain: 'napolab', token: 't' });
      expect(result.isOk()).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
