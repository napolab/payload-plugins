export class ResolveUserError extends Error {
  override readonly name = 'ResolveUserError';

  constructor(cause: unknown) {
    super('Failed to resolve the Payload user for the Cloudflare Access identity', { cause });
  }
}

// header 由来も cookie 由来も同じ class で表す。どちらだったかは strategy の warn ログの `source` に出る。
export class CrossSiteAccessRequest extends Error {
  override readonly name = 'CrossSiteAccessRequest';

  constructor() {
    super('Cloudflare Access token was sent on a cross-site request');
  }
}

export class AccessTargetCollectionNotFound extends Error {
  override readonly name = 'AccessTargetCollectionNotFound';

  constructor(readonly slug: string | undefined) {
    super(
      slug === undefined
        ? 'Cloudflare Access is configured but no auth collection exists to attach it to. Set `admin.user` or pass `collection` to cloudflareAccessPlugin.'
        : `Cloudflare Access is configured but "${slug}" is not an auth collection in the Payload config. Fix \`admin.user\` / the plugin \`collection\` option, or leave the plugin's \`teamDomain\` / \`aud\` options empty to disable it.`,
    );
  }
}

export class AccessLogoutEndpointsDisabled extends Error {
  override readonly name = 'AccessLogoutEndpointsDisabled';

  constructor(readonly slug: string) {
    super(
      `Cloudflare Access is configured but "${slug}" sets \`endpoints: false\`, so the Access logout endpoint cannot be added (adding it would re-enable every default REST endpoint of the collection). Remove \`endpoints: false\` from "${slug}", or leave the plugin's \`teamDomain\` / \`aud\` options empty to disable it.`,
    );
  }
}

// profile.map が throw した。プロフィール同期の失敗は認証を落とさず warn だけ出す。
export class AccessProfileMapFailed extends Error {
  override readonly name = 'AccessProfileMapFailed';

  constructor(cause: unknown) {
    super('The Cloudflare Access profile mapper threw', { cause });
  }
}

export class AccessProfileUpdateFailed extends Error {
  override readonly name = 'AccessProfileUpdateFailed';

  constructor(cause: unknown) {
    super('Failed to write the Cloudflare Access profile to the Payload user', { cause });
  }
}
