import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['web/src/**/*.test.{ts,tsx}', 'supabase/functions/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'jsdom',
  },
});
