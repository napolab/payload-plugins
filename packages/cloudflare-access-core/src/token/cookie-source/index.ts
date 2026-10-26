import { err, ok } from 'neverthrow';

import { getCookie } from '../../utils/cookies/index.js';
import type { TokenSource } from '../types.js';

const ACCESS_COOKIE_NAME = 'CF_Authorization';

export const cookieTokenSource: TokenSource = {
  run: (headers) => {
    const token = getCookie(headers.get('cookie') ?? '', ACCESS_COOKIE_NAME);
    if (token === undefined || token === '') return err(headers);

    return ok({ token, source: 'cookie' });
  },
};
