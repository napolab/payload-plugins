---
name: cloudflare-access-core
description: Verify Cloudflare Access application tokens outside Payload with @napolab/cloudflare-access-core - extract the token from Cf-Access-Jwt-Assertion / CF_Authorization, check CSRF with Fetch Metadata, verify the JWT against the team's JWKS, read custom IdP claims, and fetch the user's profile from get-identity. Use when writing a Cloudflare Worker, Hono / Next.js middleware, or any fetch-based server code that must trust a Cloudflare Access login, or when extending @napolab/payload-cloudflare-access with custom verification.
---

# Verify Cloudflare Access tokens with @napolab/cloudflare-access-core

Framework-agnostic helpers that only need `fetch`, `Headers` and Web Crypto (Workers, Node 20+, Bun, Deno). For Payload admin login, use the `setup-payload-cloudflare-access` skill instead; this package is what it is built on.

```bash
pnpm add @napolab/cloudflare-access-core
```

Every feature is a subpath import; there is no root entry. Results are [neverthrow](https://github.com/supermacro/neverthrow) `Result` / `ResultAsync`: handle them with `.match`, `.isErr()`, `.andThen`, never with `try` / `catch`. If the project does not use neverthrow yet, `.match(ok, err)` at the boundary is enough.

| Import                                           | Use                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `@napolab/cloudflare-access-core/team-domain`    | `normalizeTeamDomain(raw)` -> team name or `undefined`; throws when invalid |
| `@napolab/cloudflare-access-core/audiences`      | `parseAudiences("aud-1, aud-2")` -> `['aud-1', 'aud-2']`                    |
| `@napolab/cloudflare-access-core/token`          | `extractAccessToken(headers)` -> `Result<{ token, source }, ...>`           |
| `@napolab/cloudflare-access-core/fetch-metadata` | `readFetchMetadata(headers)` -> `{ origin, fetchSite, fetchDest }`          |
| `@napolab/cloudflare-access-core/csrf`           | `isAllowedHeaderRequest`, `isAllowedCookieRequest`                          |
| `@napolab/cloudflare-access-core/verify`         | `createAccessKeys`, `verifyAccessJWT`, `createAccessJWTVerifier`, adapters  |
| `@napolab/cloudflare-access-core/identity`       | `fetchAccessProfile` (get-identity), `toAccessProfile`                      |
| `@napolab/cloudflare-access-core/errors`         | Error classes (all JWT errors extend `AccessJWTError`)                      |

## Standard flow

Always do the four steps in this order: extract → CSRF check → verify → use the identity.

```ts
import { parseAudiences } from '@napolab/cloudflare-access-core/audiences';
import { isAllowedCookieRequest, isAllowedHeaderRequest } from '@napolab/cloudflare-access-core/csrf';
import { readFetchMetadata } from '@napolab/cloudflare-access-core/fetch-metadata';
import { normalizeTeamDomain } from '@napolab/cloudflare-access-core/team-domain';
import { extractAccessToken } from '@napolab/cloudflare-access-core/token';
import { createAccessKeys, verifyAccessJWT } from '@napolab/cloudflare-access-core/verify';

const teamDomain = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN); // undefined when unset
const aud = parseAudiences(env.CF_ACCESS_AUD ?? '');
const allowedOrigins = ['https://example.com'];

// Create once per isolate / process and reuse: jose caches the JWKS inside it.
const keys = teamDomain === undefined ? undefined : createAccessKeys(teamDomain);

export const authenticate = async (request: Request): Promise<string | undefined> => {
  if (teamDomain === undefined || keys === undefined || aud.length === 0) return undefined;

  const token = extractAccessToken(request.headers);
  if (token.isErr()) return undefined;

  const isAllowed = token.value.source === 'header' ? isAllowedHeaderRequest : isAllowedCookieRequest;
  if (!isAllowed(readFetchMetadata(request.headers), allowedOrigins)) return undefined;

  const identity = await verifyAccessJWT({ token: token.value.token, teamDomain, aud, keys });
  return identity.match(
    ({ email }) => email,
    () => undefined,
  );
};
```

Rules:

- **Never skip the CSRF check.** Both token sources originate from the `CF_Authorization` cookie, which the browser attaches to cross-site requests too. Pick the rule by `source` exactly as above. An empty allow-list allows every `Origin`.
- **Create `keys` once** at module scope, not per request; per-request creation refetches the JWKS every time.
- Do not decode the JWT yourself or trust `Cf-Access-Authenticated-User-Email`; that header is spoofable when the origin is reachable without Access.
- Lower-case the email before using it as a key (`@napolab/payload-cloudflare-access` does); the casing comes from the IdP.
- `verifyAccessJWT` checks RS256 only, issuer `https://<team>.cloudflareaccess.com`, any of `aud`, 30 s clock tolerance, `type === 'app'` and a non-empty `email`. Service tokens fail with `MissingAccessEmail`; to accept them, write an adapter that reads `common_name` instead.

## Hono middleware example

```ts
import { createMiddleware } from 'hono/factory';

type Env = { Variables: { accessEmail: string } };

export const requireAccess = createMiddleware<Env>(async (c, next) => {
  const email = await authenticate(c.req.raw);
  if (email === undefined) return c.json({ message: 'Unauthorized' }, 401);

  c.set('accessEmail', email);
  await next();
});
```

In a Worker, `env` is only available inside `fetch`; build `teamDomain` / `aud` / `keys` lazily on the first request and cache them in module scope.

## Custom claims

OIDC claims / SAML attributes configured on the IdP arrive in the JWT's `custom` claim (dropped by Access above ~1 KB). Read them with an identity adapter; signature, issuer, audience, expiry and `type` are checked before it runs:

```ts
import { err, ok } from 'neverthrow';
import { InvalidAccessClaims, MissingAccessEmail } from '@napolab/cloudflare-access-core/errors';
import { createAccessJWTVerifier } from '@napolab/cloudflare-access-core/verify';
import type { AccessIdentityAdapter } from '@napolab/cloudflare-access-core/verify';

type Member = { email: string; groups: readonly string[] };

const isStringArray = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

const readGroups = (custom: unknown): unknown => {
  if (typeof custom !== 'object' || custom === null || !('groups' in custom)) return undefined;
  return custom.groups;
};

const memberIdentity: AccessIdentityAdapter<Member> = (payload) => {
  const email = payload['email'];
  if (typeof email !== 'string' || email === '') return err(new MissingAccessEmail());

  const groups = readGroups(payload['custom']);
  if (!isStringArray(groups)) return err(new InvalidAccessClaims('custom.groups'));

  return ok({ email, groups });
};

export const verifyMember = createAccessJWTVerifier(memberIdentity);
```

Built-in adapters: `emailIdentity` (`{ email }`, what `verifyAccessJWT` uses) and `sessionIdentity` (`{ email, issuedAt }` from `iat`, to do something once per Access login).

## Profile from get-identity

The JWT carries only the email unless the IdP is configured otherwise. For name / picture / IdP, call get-identity with an **already verified** token:

```ts
import { fetchAccessProfile } from '@napolab/cloudflare-access-core/identity';

const profile = await fetchAccessProfile({ teamDomain, token });
// ResultAsync<{ email, name?, picture?, idp? }, AccessIdentityFetchFailed | InvalidAccessIdentity>
```

- It is a network call to `https://<team>.cloudflareaccess.com`; do it once per session, not on every request.
- An expired token gets a non-2xx (`AccessIdentityFetchFailed` with `status`); the login redirect is not followed.
- `picture` is only kept when it is an `https:` URL.
- Pass `fetch` in the args to stub it in tests; `toAccessProfile(json)` is the pure parser.

## Testing

Unit-test the handler by stubbing `keys` with a local JWKS: generate an RS256 key pair with `jose` (`generateKeyPair('RS256')`, `SignJWT`), sign `{ email, type: 'app' }` with issuer `https://<team>.cloudflareaccess.com` and the expected `aud`, and pass `createLocalJWKSet({ keys: [publicJwk] })` as `keys`. Set `Origin` / `Sec-Fetch-Site` / `Sec-Fetch-Dest` headers to cover the CSRF branches.
