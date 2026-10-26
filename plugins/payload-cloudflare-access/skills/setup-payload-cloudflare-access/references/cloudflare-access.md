# Cloudflare Access side

## Application

Zero Trust dashboard → Access → Applications → Add an application → **Self-hosted**.

- **Domain / path**: the host that serves Payload. Protect the whole host, or at least `/admin` and `/api` (the admin calls `/api/<collection>/me`, `/api/<collection>/access-logout`, ... with the same cookie). Frontend routes can stay public if they are separate applications or paths; requests without an Access token simply get no user.
- **Policies**: an `Allow` policy listing who may be an admin (emails, email domain, IdP group). This is the only authorization check: everyone allowed here becomes a Payload admin.
- **Identity providers**: any. For profile sync, an OIDC IdP that sends `name` / `picture` claims gives the best result.
- After saving, copy the **Application Audience (AUD) Tag** into `CF_ACCESS_AUD`.

Several applications (e.g. one for `/admin`, one for an MCP endpoint) can share the Payload instance: put all their AUD tags in `CF_ACCESS_AUD`, comma-separated.

## How the token reaches Payload

- Access sets the `CF_Authorization` cookie on the protected host after login.
- On proxied requests the edge also adds the `Cf-Access-Jwt-Assertion` header.
- The plugin reads the header first, then the cookie, verifies the RS256 signature against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, the issuer, the audience (any listed AUD), a 30 second clock tolerance, `type === 'app'` and a non-empty `email`.

The server must be able to reach `https://<team>.cloudflareaccess.com` (JWKS and, with profile sync, `get-identity`).

## Deployment checklist

- [ ] Access application covers `/admin` and `/api` on the production host.
- [ ] `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` set in the production environment (not only at build time if the config is evaluated at runtime).
- [ ] `pnpm payload generate:importmap` run and committed.
- [ ] The sanitized `csrf` list includes the production origin. Payload appends `serverURL` to `csrf`, so a `serverURL` that differs from the browser's origin (e.g. `http://localhost:3000` in production) makes the list non-empty and rejects every same-origin request carrying `Origin`.
- [ ] Preview / staging hosts either have their own Access application (add its AUD) or leave the env vars unset.
- [ ] Someone who must keep admin access is in the Access policy before switching it on.

## Local development

Leave both env vars unset and log in with a password as usual. To test the Access path locally, run the dev server behind `cloudflared tunnel` on a hostname covered by an Access application.
