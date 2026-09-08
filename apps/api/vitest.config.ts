import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    // The source imports siblings with a .js extension, which is what NodeNext
    // requires and what tsc emits. Vitest reads the TypeScript, so the
    // extension has to be mapped back.
    extensions: ['.ts', '.js', '.json'],
  },
});
