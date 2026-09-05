import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

const migrations = await readD1Migrations('./migrations');

export default defineWorkersConfig({
  test: {
    // Worker tests only. The browser wizard tests live in e2e/ and run
    // under `npm run test:web`; they cannot run in the workers pool.
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
    poolOptions: {
      workers: {
        singleWorker: true,
        isolatedStorage: false,
        wrangler: { configPath: './wrangler.toml' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      },
    },
  },
});
