import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

const listSourceFiles = (dir: string): readonly string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });

// `payload` / `@payloadcms/*` を import しない。core は Payload 抜きでも (Workers の middleware などで) 使えることが前提。
const PAYLOAD_IMPORT = /from\s+['"](?:payload|@payloadcms\/)|import\(\s*['"](?:payload|@payloadcms\/)/;

describe('cloudflare-access-core package boundary', () => {
  const files = listSourceFiles(SRC_DIR);

  it('finds the core source files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [file.slice(SRC_DIR.length), file]))('%s does not import payload', (_name, file) => {
    expect(readFileSync(file, 'utf8')).not.toMatch(PAYLOAD_IMPORT);
  });
});
