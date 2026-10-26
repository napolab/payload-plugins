# Troubleshooting @napolab/payload-cloudflare-access

Start from the server log. The strategy never throws on a request; it logs and returns no user:

- `warn` **"Cloudflare Access authentication rejected"** with `err` and `source` (`header` / `cookie`): the token was rejected (cross-site request or JWT verification). Look at `err.name`.
- `error` **"Cloudflare Access user resolution failed"** (`ResolveUserError`): the token was valid but finding / creating the user failed. Look at `err.cause` (DB error, required field without a default, a `beforeChange` hook that throws, ...).

## Errors at config load (the app does not start)

| Error                            | Cause / fix                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InvalidAccessTeamDomain`        | `CF_ACCESS_TEAM_DOMAIN` is not a team name. Use `<team>`, `<team>.cloudflareaccess.com` or `https://<team>.cloudflareaccess.com`.                                         |
| `AccessTargetCollectionNotFound` | `collection` / `admin.user` points at a slug that does not exist or is not an auth collection, or no auth collection exists. Fix the option or register the plugin later. |
| `AccessLogoutEndpointsDisabled`  | The target collection has `endpoints: false`. Remove it (adding the logout endpoint would otherwise re-enable all default REST endpoints).                                |

These only fire while both env vars are set. Unsetting either one disables the plugin and lets the app start.

## Rejected tokens (`err.name` in the warn log)

| `err.name`               | Meaning / fix                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CrossSiteAccessRequest` | `Origin` is not in the sanitized `csrf` list, or a cross-site subresource request. Check `csrf` and `serverURL` (Payload appends `serverURL` to `csrf`).                            |
| `InvalidAccessToken`     | Signature, issuer, audience or expiry failed. Most often `CF_ACCESS_AUD` is not this application's AUD, or `CF_ACCESS_TEAM_DOMAIN` is another team. `err.cause` has the jose error. |
| `WrongAccessTokenType`   | The token's `type` is not `app` (e.g. an org-level token). Use the application token.                                                                                               |
| `MissingAccessEmail`     | No `email` claim, typically an Access service token. Service tokens cannot sign in through this plugin.                                                                             |
| `InvalidAccessClaims`    | With `profile` set, the token has no numeric `iat`.                                                                                                                                 |

## No log line at all, but the user is not signed in

No token reached Payload. Check that:

- the request host / path is covered by the Access application (`/admin` **and** `/api`),
- both env vars are set at runtime in that environment (log `Boolean(process.env.CF_ACCESS_AUD)` once if unsure),
- the request goes through Cloudflare (not directly to the origin / a preview URL that bypasses Access).

## Logout button missing or admin fails to render

The import map is stale. Run `pnpm payload generate:importmap` and commit it. The same applies after adding `profile.avatarField`.

## Logout returns 403

`POST /api/<collection>/access-logout` rejects cross-site requests with the same rules as Payload's cookie auth. Check `csrf` / `serverURL` as for `CrossSiteAccessRequest`.

## Profile is not synced

- A `warn` log with `AccessIdentityFetchFailed` (with `status`) / `InvalidAccessIdentity` / `AccessProfileMapFailed` / `AccessProfileUpdateFailed` names the step that failed.
- The sync runs once per Access session. To force it, log out (ends the Access session) and log in again.
- `name` / `picture` are `undefined` when the IdP does not send them; One-time PIN never does.

## "Cloudflare Access 有効時はパスワードを設定できません" (403)

Expected: `PasswordWriteForbidden` rejects any `create` / `update` with a `password` key while Access is enabled. Remove `password` from seed scripts and forms, or run them with the env vars unset.
