# @napolab/payload-cloudflare-access

A [Payload CMS](https://payloadcms.com/) plugin that signs admin users in with [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) instead of passwords.

When enabled, the plugin:

- adds an auth strategy that verifies the Access application token (`Cf-Access-Jwt-Assertion` header, or the `CF_Authorization` cookie) and finds or creates the Payload user by its email,
- turns off the local (password) strategy of the target collection,
- rejects any `create` / `update` that writes a `password`,
- adds a `POST /api/<collection>/access-logout` endpoint and replaces the admin logout button so that logging out also ends the Access session,
- optionally syncs the display name / avatar from the Access identity into fields you own.

Access policies are the only authorization boundary: every email that passes Access is treated as an admin user.

## Install

```bash
pnpm add @napolab/payload-cloudflare-access
```

Peer dependencies: `payload` `^3.91.0`, `@payloadcms/ui` `^3.91.0`, `react` `^19.0.0`.

## Usage

```ts
// payload.config.ts
import { buildConfig } from 'payload';
import { cloudflareAccessPlugin } from '@napolab/payload-cloudflare-access/plugin';

export default buildConfig({
  // ...
  plugins: [
    cloudflareAccessPlugin({
      teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN,
      aud: process.env.CF_ACCESS_AUD,
      // collection: 'users', // optional
    }),
  ],
});
```

Then regenerate the import map (`pnpm payload generate:importmap`) so the admin can load the logout button (and the avatar, when `profile.avatarField` is set).

### Options

| Option       | Type                  | Description                                                                                                                                                  |
| ------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `teamDomain` | `string \| undefined` | Your Access team name, e.g. `napolab` for `https://napolab.cloudflareaccess.com`. A full URL / `*.cloudflareaccess.com` host is normalized to the team name. |
| `aud`        | `string \| undefined` | The Application Audience (AUD) tag. Pass a comma-separated list to accept several Access applications (e.g. `"aud-admin,aud-mcp"`).                          |
| `collection` | `string` (optional)   | The auth collection to attach to. Defaults to `admin.user`, then the first auth collection.                                                                  |
| `profile`    | `object` (optional)   | Sync the display name / avatar from the Access identity into the user doc. See [Profile sync](#profile-sync).                                                |

### Enabling and disabling

The plugin is **disabled unless both `teamDomain` and `aud` are set** (non-empty). While disabled it leaves authentication untouched, so you can roll it out by setting the two env vars and roll it back by unsetting either one.

When enabled, misconfiguration fails loudly instead of silently keeping password login:

- `teamDomain` that is not a team name throws `InvalidAccessTeamDomain`.
- A target collection that does not exist or is not an auth collection throws `AccessTargetCollectionNotFound`.
- A target collection with `endpoints: false` throws `AccessLogoutEndpointsDisabled` (adding the logout endpoint would re-enable every default REST endpoint).

### Password writes

While Access is enabled, the target collection keeps its `email` / `hash` columns (`disableLocalStrategy: { enableFields: true }`), but any `create` or `update` whose data contains a `password` key is rejected with a 403 (`PasswordWriteForbidden`). Otherwise a password set now would become a valid login the moment Access is turned off.

### Logout button

The plugin always registers `admin.components.logout.Button` (`@napolab/payload-cloudflare-access/client/logout-button#LogoutButton`), so the import map does not depend on env vars.

- Access enabled: the button POSTs to `/api/<collection>/access-logout`. The endpoint expires the Payload token cookie and the Next.js draft mode cookie, then redirects (303) to `/cdn-cgi/access/logout`. Cross-site requests get a 403.
- Access disabled: it renders Payload's default logout.

### Profile sync

Pass `profile` to copy the user's Access identity (from `https://<team>.cloudflareaccess.com/cdn-cgi/access/get-identity`) into your own fields of the user collection. The plugin never adds fields; you map the profile onto fields you define.

```ts
// collections/users.ts
export const Users: CollectionConfig = {
  slug: 'users',
  auth: true,
  admin: { useAsTitle: 'displayName' },
  fields: [
    { name: 'displayName', type: 'text' },
    { name: 'avatarURL', type: 'text' },
  ],
};

// payload.config.ts
cloudflareAccessPlugin({
  teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN,
  aud: process.env.CF_ACCESS_AUD,
  profile: {
    // AccessProfile -> data written to the user doc. Return only the fields you own.
    map: ({ name, picture }) => ({ displayName: name ?? null, avatarURL: picture ?? null }),
    // Optional: show this field's image as the admin avatar.
    avatarField: 'avatarURL',
  },
});
```

`map` receives an `AccessProfile` from [`@napolab/cloudflare-access-core/identity`](https://www.npmjs.com/package/@napolab/cloudflare-access-core):

| Field     | Value                                                                       |
| --------- | --------------------------------------------------------------------------- |
| `email`   | The Access email.                                                           |
| `name`    | The display name (`name`, falling back to the OIDC `name`), or `undefined`. |
| `picture` | The OIDC `picture` when it is an `https:` URL, or `undefined`.              |
| `idp`     | `{ id, type }` of the identity provider, or `undefined`.                    |

Its return value is typed from your generated types (`Partial<RequiredDataFromCollectionSlug<…>>`). `email` cannot be overwritten by `map`.

When the profile is written:

- **On auto-create.** The profile is fetched before the user is created and the mapped data is part of the create.
- **Once per Access session.** For an existing user, the profile is fetched again when the token's `iat` (the Access login time) is newer than the user's `updatedAt`, and the result of `map` is written with `payload.update`. The write always happens (even when nothing changed), so `updatedAt` moves past `iat` and the rest of the session does not fetch again. Logging in to Access again starts a new session and syncs again. No extra field and no in-memory cache are used.

Profile sync never changes the authentication decision. A failed fetch, a `map` that throws or a failed update is logged with `payload.logger.warn` and the user is signed in as before (on auto-create, the user is created without the profile; the next sync happens on the next Access login). The one difference with `profile` set is that the token must carry a numeric `iat` (Access always issues one).

Without `profile` the plugin does not fetch anything.

#### Avatar

With `avatarField`, the plugin sets `admin.avatar` to `@napolab/payload-cloudflare-access/client/access-avatar#AccessAvatar`, which shows the image in that field of the signed-in user (25px circle, like Payload's Gravatar) and falls back to Payload's default account icon when the field is empty. It is registered whenever `avatarField` is set, independently of the Access env vars, so the import map stays stable. Regenerate the import map after adding it.

### Cross-site requests

The Access token comes from a cookie the browser sends automatically, so the strategy applies Payload's `csrf` allow-list to both sources. A cross-site top-level navigation without `Origin` is allowed (that is how the Access login redirect lands on `/admin`). Cross-site navigations to deeper admin paths should be redirected to `/admin` by your worker or middleware.

## Entry points

| Import                                                    | Exports                                                                                                                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@napolab/payload-cloudflare-access/plugin`               | `cloudflareAccessPlugin`, `ACCESS_LOGOUT_BUTTON_PATH`, `ACCESS_AVATAR_PATH`, `CloudflareAccessPluginOptions`, `CloudflareAccessProfileOptions`                         |
| `@napolab/payload-cloudflare-access/resolve-user`         | `resolveAccessUser`, `createPayloadUserStore`, `toAccessUser`, `AccessUser`, `AccessUserData`, `AccessUserCreateData`, `UserStore`                                     |
| `@napolab/payload-cloudflare-access/profile-sync`         | `needsProfileSync`, `syncProfile`, `withProfileOnCreate`, `createPayloadProfileWriter`, `AccessProfileMapper`, `ProfileSource`, `ProfileSyncDeps`, `ProfileSyncLogger` |
| `@napolab/payload-cloudflare-access/errors`               | `ResolveUserError`, `CrossSiteAccessRequest`, `AccessTargetCollectionNotFound`, `AccessLogoutEndpointsDisabled`, `AccessProfileMapFailed`, `AccessProfileUpdateFailed` |
| `@napolab/payload-cloudflare-access/client/logout-button` | `LogoutButton` (client component)                                                                                                                                      |
| `@napolab/payload-cloudflare-access/client/access-avatar` | `AccessAvatar` (client component)                                                                                                                                      |

JWT verification, token extraction and the CSRF checks live in [`@napolab/cloudflare-access-core`](https://www.npmjs.com/package/@napolab/cloudflare-access-core); import them from there.

## License

MIT
