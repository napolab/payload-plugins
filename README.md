# payload-plugins

Payload CMS plugins by napolab, published as separate npm packages.

| Package                                                                      | Description                                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`@napolab/payload-cloudflare-access`](./packages/payload-cloudflare-access) | Sign Payload admin users in with Cloudflare Access instead of passwords.  |
| [`@napolab/cloudflare-access-core`](./packages/cloudflare-access-core)       | Framework-agnostic Cloudflare Access JWT helpers (no Payload dependency). |

## Development

Tooling is pinned with [mise](https://mise.jdx.dev/) (Node 24, pnpm 10).

```bash
mise install
pnpm install
pnpm exec playwright install chromium # once, for the browser test project

pnpm lint       # oxfmt --check + oxlint
pnpm fmt        # oxfmt --write + oxlint --fix
pnpm typecheck  # tsgo
pnpm test       # vitest (unit: node, browser: Playwright Chromium)
pnpm build      # swc + tsgo declarations into packages/*/dist
```

During development, each package's `exports` point at `src/*.ts`. `publishConfig.exports` swaps them for `dist/*.js` + `dist/*.d.ts` when the package is packed (`pnpm pack` / `pnpm publish`).

## Releasing

Releases use [Changesets](https://github.com/changesets/changesets).

1. Add a changeset with `pnpm changeset` in your PR.
2. On `main`, the Release workflow opens a "Version Packages" PR.
3. Merging that PR publishes the bumped packages to npm.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (GitHub OIDC, with provenance). There is no `NPM_TOKEN` secret.

> [!IMPORTANT]
> npm only lets you configure a trusted publisher for a package that already exists. Publish the **first version of each package manually** (`pnpm build && cd packages/<name> && pnpm publish --access public`), then add `napolab/payload-plugins` + `release.yml` as the trusted publisher on npmjs.com for each package.

## License

MIT
