import { err, ok } from 'neverthrow';

import type { TokenSource } from '../types.js';

const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';

export const headerTokenSource: TokenSource = {
  run: (headers) => {
    const token = headers.get(ACCESS_JWT_HEADER)?.trim();
    if (token === undefined || token === '') return err(headers);

    return ok({ token, source: 'header' });
  },
};
