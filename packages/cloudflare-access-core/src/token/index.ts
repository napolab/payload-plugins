import { cookieTokenSource } from './cookie-source/index.js';
import { headerTokenSource } from './header-source/index.js';
import { createTokenRunner } from './runner/index.js';

// The registry is internal to the package: the order is header -> cookie (first match wins).
const sources = [headerTokenSource, cookieTokenSource] as const;

export const extractAccessToken = createTokenRunner(sources);

export type { AccessToken, AccessTokenSourceName, TokenSource } from './types.js';
