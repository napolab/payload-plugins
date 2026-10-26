---
name: setup-payload-cloudflare-access
description: Add Cloudflare Access login to a Payload CMS 3 project with @napolab/payload-cloudflare-access - install, wire cloudflareAccessPlugin into payload.config.ts, set CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD, regenerate the import map, sync the display name / avatar from the Access identity, and debug why Access login does not work. Use when the user wants to replace Payload admin passwords with Cloudflare Access / Zero Trust, protect /admin with Access, or mentions cloudflareAccessPlugin.
---

# Set up @napolab/payload-cloudflare-access

`cloudflareAccessPlugin` signs Payload admin users in with the Cloudflare Access application token instead of a password. Access policies become the only authorization boundary: **every email that passes Access is treated as an admin user** and is auto-created in the auth collection on first visit. Confirm the user is fine with that before going further; if they need roles, they must add them themselves (the plugin never adds fields).

## 1. Check the project

Before editing anything, read:

- `package.json`: `payload` and `@payloadcms/ui` must be `^3.91.0`, `react` `^19`. If they are older, tell the user to upgrade Payload first.
- `payload.config.ts` (or wherever `buildConfig` is called): note `admin.user`, the `plugins` array, `csrf`, `serverURL`, `routes.api`.
- The auth collection that admins log in to (usually `users`). It must not set `endpoints: false`.

Detect the package manager from the lockfile (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`) and use it for every command below.

## 2. Install

```bash
pnpm add @napolab/payload-cloudflare-access
```

`@napolab/cloudflare-access-core` comes with it as a dependency. Add it explicitly only if the project imports from it directly.

## 3. Register the plugin

```ts
// payload.config.ts
import { buildConfig } from 'payload';
import { cloudflareAccessPlugin } from '@napolab/payload-cloudflare-access/plugin';

export default buildConfig({
  // ...
  plugins: [
    // ...existing plugins
    cloudflareAccessPlugin({
      teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN,
      aud: process.env.CF_ACCESS_AUD,
      // collection: 'users', // only when admins do not log in to `admin.user` / the first auth collection
    }),
  ],
});
```

- Import only from subpaths (`/plugin`, `/profile-sync`, ...). There is no root entry.
- Pass the env vars through as they are, including `undefined`. Do not add `!` or `?? ''` defaults: the plugin is **disabled unless both values are non-empty**, and that is the rollout / rollback switch.
- Put it after plugins that add or modify the auth collection, so the collection exists when this plugin runs.

## 4. Environment variables

Add both to `.env.example` (and to the deployment's secrets), leaving them empty locally unless the dev server sits behind Access:

```bash
# Cloudflare Access team name (`<team>` in https://<team>.cloudflareaccess.com). A full URL is also accepted.
CF_ACCESS_TEAM_DOMAIN=
# Application Audience (AUD) tag. Comma-separate to accept several Access applications.
CF_ACCESS_AUD=
```

Where the user finds them in the Cloudflare dashboard (Zero Trust):

- **Team domain**: Settings → Team name and domain (or the `*.cloudflareaccess.com` host of the login page).
- **AUD**: Access → Applications → the self-hosted application → Overview / Basic information → "Application Audience (AUD) Tag".

The Access application must cover the paths the admin uses: at least `<host>/admin` and `<host>/api` (or the whole host). See [references/cloudflare-access.md](references/cloudflare-access.md) for the application setup and the deployment checklist.

## 5. Regenerate the import map

The plugin always registers `admin.components.logout.Button` (and `admin.avatar` when `profile.avatarField` is set), independent of the env vars:

```bash
pnpm payload generate:importmap
```

Commit the regenerated `importMap.js`. Without this step the admin fails to render the logout button.

## 6. Optional: profile sync

If the user wants a display name / avatar, add fields they own and map the Access profile onto them:

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
    // AccessProfile { email, name?, picture?, idp? } -> data written to the user doc.
    map: ({ name, picture }) => ({ displayName: name ?? null, avatarURL: picture ?? null }),
    avatarField: 'avatarURL', // optional: shows that field's image as the admin avatar
  },
});
```

- `map` is typed from the generated `payload-types.ts`; run `pnpm payload generate:types` after adding the fields. `email` cannot be overwritten.
- The profile comes from `https://<team>.cloudflareaccess.com/cdn-cgi/access/get-identity`. It is written on auto-create and once per Access session (when the token's `iat` is newer than the user's `updatedAt`).
- Sync failures only log `payload.logger.warn`; they never block login.
- `picture` is only set for an `https:` URL from the IdP's OIDC claims. Many IdPs (e.g. One-time PIN) send no name or picture, so `map` must handle `undefined`.
- Regenerate the import map after adding `avatarField`.

## 7. Optional: redirect cross-site deep links to /admin

The strategy only sees headers, so it allows a cross-site top-level navigation without `Origin` (that is how the Access login redirect lands on `/admin`). Recommend redirecting cross-site navigations to deeper admin paths. In a Next.js app:

```ts
// middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export const config = { matcher: ['/admin/:path+'] };

export const middleware = (request: NextRequest) => {
  const isCrossSiteNavigation = request.headers.get('sec-fetch-site') === 'cross-site' && request.headers.get('sec-fetch-dest') === 'document';
  if (isCrossSiteNavigation) return NextResponse.redirect(new URL('/admin', request.url));

  return NextResponse.next();
};
```

If the project already has a middleware, merge this check into it instead of replacing it.

## 8. Verify

1. With the env vars unset: `pnpm dev`, password login still works (the plugin is disabled).
2. Deploy behind Access with both env vars set. Opening `/admin` goes through the Access login and lands signed in; the user doc is created with the Access email (lower-cased).
3. "Log out" goes to `/cdn-cgi/access/logout`, which ends the Access session for every Access application of the team.
4. Setting a password from the admin or the REST API returns 403.

If something fails, follow [references/troubleshooting.md](references/troubleshooting.md).

## Behaviour to explain to the user

- The local (password) strategy of the target collection is turned off; `email` / `hash` columns stay (`disableLocalStrategy: { enableFields: true }`).
- Any `create` / `update` whose data contains a `password` key is rejected with 403 (`PasswordWriteForbidden`), so no password becomes usable when Access is turned off.
- Rollback: unset either env var and redeploy. Existing users keep their rows but have no password; use Payload's forgot-password flow or set one via the local API after rollback.
- When enabled, misconfiguration throws at config load instead of silently keeping password login: `InvalidAccessTeamDomain`, `AccessTargetCollectionNotFound`, `AccessLogoutEndpointsDisabled`.
- Machine clients (CI, scripts): an Access service token gets a request through the Access edge, but its JWT has no `email` claim, so the plugin does not sign it in (`MissingAccessEmail`). Authenticate those requests to Payload another way, e.g. an API key (`auth.useAPIKey`).
