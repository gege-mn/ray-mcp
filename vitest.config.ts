import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    // Tests bind local ports; one worker keeps memory use low.
    fileParallelism: false,
  },
});
