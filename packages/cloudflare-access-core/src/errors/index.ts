export abstract class AccessJWTError extends Error {}

export class InvalidAccessToken extends AccessJWTError {
  override readonly name = 'InvalidAccessToken';

  constructor(cause: unknown) {
    super('Cloudflare Access JWT failed verification', { cause });
  }
}

export class WrongAccessTokenType extends AccessJWTError {
  override readonly name = 'WrongAccessTokenType';

  constructor(readonly tokenType: unknown) {
    super('Cloudflare Access JWT is not an app token');
  }
}

export class MissingAccessEmail extends AccessJWTError {
  override readonly name = 'MissingAccessEmail';

  constructor() {
    super('Cloudflare Access JWT has no email claim');
  }
}

// identity adapter が独自 claim を読めなかったときに返す。claim はドット区切りのパス(例: `custom.groups`)。
export class InvalidAccessClaims extends AccessJWTError {
  override readonly name = 'InvalidAccessClaims';

  constructor(readonly claim: string) {
    super(`Cloudflare Access JWT has a missing or invalid "${claim}" claim`);
  }
}

export class InvalidAccessTeamDomain extends Error {
  override readonly name = 'InvalidAccessTeamDomain';

  constructor(readonly raw: string) {
    super(
      `CF_ACCESS_TEAM_DOMAIN "${raw}" is not a Cloudflare Access team name. Set the team name only, like \`napolab\` (from https://napolab.cloudflareaccess.com), or unset CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD to disable the plugin.`,
    );
  }
}

// get-identity の取得自体が失敗した(network エラー / 2xx 以外)。status は応答があった時だけ入る。
export class AccessIdentityFetchFailed extends Error {
  override readonly name = 'AccessIdentityFetchFailed';

  constructor(
    readonly status: number | undefined,
    cause?: unknown,
  ) {
    super(status === undefined ? 'Failed to fetch the Cloudflare Access identity' : `Cloudflare Access get-identity responded with ${status}`, { cause });
  }
}

// get-identity の応答が JSON でない、または必要な値(email)が無い。
export class InvalidAccessIdentity extends Error {
  override readonly name = 'InvalidAccessIdentity';

  constructor(
    readonly reason: string,
    cause?: unknown,
  ) {
    super(`Cloudflare Access identity is invalid: ${reason}`, { cause });
  }
}
