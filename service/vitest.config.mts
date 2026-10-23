import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/quota_test',
    },
    setupFiles: ['tests/setup.ts'],
    fileParallelism: false, 
  },
});
