# @napolab/cloudflare-access-core

Framework-agnostic helpers for [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) application tokens. It does not depend on Payload, so you can use it in a Cloudflare Worker, a Hono middleware, or any runtime with `fetch`, `Headers` and Web Crypto.

It is the building block of [`@napolab/payload-cloudflare-access`](https://www.npmjs.com/package/@napolab/payload-cloudflare-access).

## Install

```bash
pnpm add @napolab/cloudflare-access-core
```

## Entry points

Each feature has its own subpath. There is no root entry.

| Import                                           | Exports                                                                                                                                                                                      |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@napolab/cloudflare-access-core/verify`         | `verifyAccessJWT`, `createAccessJWTVerifier`, `emailIdentity`, `sessionIdentity`, `createAccessKeys`, `accessIssuer`, `AccessIdentity`, `AccessSessionIdentity`, `AccessIdentityAdapter`     |
| `@napolab/cloudflare-access-core/identity`       | `fetchAccessProfile`, `toAccessProfile`, `identityURL`, `AccessProfile`, `FetchAccessProfileArgs` (the user's Access identity from `get-identity`)                                           |
| `@napolab/cloudflare-access-core/token`          | `extractAccessToken` (header `Cf-Access-Jwt-Assertion`, then cookie `CF_Authorization`)                                                                                                      |
| `@napolab/cloudflare-access-core/audiences`      | `parseAudiences` (comma-separated AUD list)                                                                                                                                                  |
| `@napolab/cloudflare-access-core/team-domain`    | `normalizeTeamDomain`                                                                                                                                                                        |
| `@napolab/cloudflare-access-core/fetch-metadata` | `readFetchMetadata` (`Origin` / `Sec-Fetch-Site` / `Sec-Fetch-Dest`), `FetchMetadata`, `FetchSite`                                                                                           |
| `@napolab/cloudflare-access-core/csrf`           | `isAllowedHeaderRequest`, `isAllowedCookieRequest` (decisions over `FetchMetadata`)                                                                                                          |
| `@napolab/cloudflare-access-core/errors`         | `AccessJWTError`, `InvalidAccessToken`, `WrongAccessTokenType`, `MissingAccessEmail`, `InvalidAccessClaims`, `InvalidAccessTeamDomain`, `AccessIdentityFetchFailed`, `InvalidAccessIdentity` |

## Verifying an Access JWT outside Payload

```ts
import { parseAudiences } from '@napolab/cloudflare-access-core/audiences';
import { isAllowedCookieRequest, isAllowedHeaderRequest } from '@napolab/cloudflare-access-core/csrf';
import { readFetchMetadata } from '@napolab/cloudflare-access-core/fetch-metadata';
import { normalizeTeamDomain } from '@napolab/cloudflare-access-core/team-domain';
import { extractAccessToken } from '@napolab/cloudflare-access-core/token';
import { createAccessKeys, verifyAccessJWT } from '@napolab/cloudflare-access-core/verify';

// `napolab`, `https://napolab.cloudflareaccess.com/` etc. are all normalized to `napolab`.
const teamDomain = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
const aud = parseAudiences(env.CF_ACCESS_AUD ?? ''); // "aud-1, aud-2" -> ['aud-1', 'aud-2']

// Create the remote JWKS once and reuse it: jose caches the keys.
const keys = createAccessKeys(teamDomain);

const authenticate = async (request: Request) => {
  const token = extractAccessToken(request.headers);
  if (token.isErr()) return undefined;

  // Both sources come from a cookie the browser sends automatically, so check the request origin.
  const isAllowed = token.value.source === 'header' ? isAllowedHeaderRequest : isAllowedCookieRequest;
  if (!isAllowed(readFetchMetadata(request.headers), ['https://example.com'])) return undefined;

  const identity = await verifyAccessJWT({ token: token.value.token, teamDomain, aud, keys });
  return identity.match(
    ({ email }) => email,
    () => undefined,
  );
};
```

`verifyAccessJWT` returns a [neverthrow](https://github.com/supermacro/neverthrow) `ResultAsync<AccessIdentity, AccessJWTError>`. It checks the RS256 signature against the team's JWKS, the issuer (`https://<team>.cloudflareaccess.com`), the audience (any of `aud`), a 30 second clock tolerance, `type === 'app'` and a non-empty `email` claim.

`normalizeTeamDomain` returns `undefined` for an empty value and throws `InvalidAccessTeamDomain` for a value that is set but is not a team name.

## Custom claims

Access copies the OIDC claims / SAML attributes you configure on the identity provider into the JWT's `custom` claim (best effort: Access drops them when they exceed about 1 KB). To read them, pass your own identity adapter to `createAccessJWTVerifier`. The adapter receives the verified payload and returns a `Result`; signature, issuer, audience, expiry and `type === 'app'` are always checked before it runs.

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

const verifyMember = createAccessJWTVerifier(memberIdentity);
// verifyMember({ token, teamDomain, aud, keys }): ResultAsync<Member, AccessJWTError>
```

`verifyAccessJWT` is `createAccessJWTVerifier(emailIdentity)`.

`sessionIdentity` is an adapter that returns `{ email, issuedAt }`, where `issuedAt` is the Access login time (the `iat` claim). It fails with `InvalidAccessClaims('iat')` when `iat` is missing. Use it to do something once per Access session.

## Reading the user's profile (get-identity)

The JWT only carries the email unless you configure OIDC claims on the identity provider. The full identity (display name, profile picture, identity provider, ...) is available from `https://<team>.cloudflareaccess.com/cdn-cgi/access/get-identity`, authenticated with the application token as the `CF_Authorization` cookie. `fetchAccessProfile` calls it and keeps only the fields below:

```ts
import { fetchAccessProfile } from '@napolab/cloudflare-access-core/identity';

// Call it with a token you have already verified.
const profile = await fetchAccessProfile({ teamDomain, token });
// ResultAsync<AccessProfile, AccessIdentityFetchFailed | InvalidAccessIdentity>
```

| Field     | Source                                     | Notes                                                       |
| --------- | ------------------------------------------ | ----------------------------------------------------------- |
| `email`   | `email`                                    | Required; a response without it is `InvalidAccessIdentity`. |
| `name`    | `name`, falling back to `oidc_fields.name` | Trimmed; `undefined` when empty.                            |
| `picture` | `oidc_fields.picture`                      | Only an `https:` URL; otherwise `undefined`.                |
| `idp`     | `idp` (`{ id, type }`)                     | `undefined` when malformed.                                 |

- A non-2xx response (including the redirect to the login page for an expired token, which is not followed) is `AccessIdentityFetchFailed` with `status`; a network failure is `AccessIdentityFetchFailed` with `status: undefined`.
- A body that is not JSON is `InvalidAccessIdentity`.
- Pass `fetch` to use something other than `globalThis.fetch` (e.g. in tests). `toAccessProfile(json)` is the pure parser on its own.

## License

MIT
