import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { configDefaults, defineConfig } from 'vitest/config';

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/dist/**'],
    // browser mode は CI 素環境で Vite の依存最適化による mid-run リロードが起き、
    // 進行中の dynamic import が "Failed to fetch" になることがある（フレーク）。
    // CI のみ retry してこの一過性の取りこぼしを吸収する（ローカルは 0 で即検知）。
    retry: process.env['CI'] === undefined ? 0 : 2,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        resolve: {
          // `@payloadcms/ui` is a Payload admin bundle with Node-only deps; the
          // dep scanner crawling it triggers mid-run reloads, and `vi.mock` does
          // not stop the scan. Alias it to a stub that exposes only what the
          // client components use. See packages/payload-cloudflare-access/src/__mocks__/payloadcms-ui.tsx.
          // Array form so the deep import is matched before the bare specifier
          // (a string alias for `@payloadcms/ui` would also rewrite `@payloadcms/ui/...`).
          alias: [
            {
              find: /^@payloadcms\/ui\/graphics\/Account\/Default$/,
              replacement: fromRoot('./packages/payload-cloudflare-access/src/__mocks__/payloadcms-ui-account-default.tsx'),
            },
            { find: /^@payloadcms\/ui$/, replacement: fromRoot('./packages/payload-cloudflare-access/src/__mocks__/payloadcms-ui.tsx') },
          ],
        },
        // Pre-bundle every browser-test dependency up front so Vite does not
        // discover one late and reload mid-run ("optimized dependencies changed").
        optimizeDeps: {
          include: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'vitest-browser-react'],
        },
        test: {
          name: 'browser',
          include: ['packages/*/src/**/*.test.tsx'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            screenshotFailures: false,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
