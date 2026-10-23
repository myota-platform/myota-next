import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`. Requires Vite 8, which ships this option.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    // Browser specs use Playwright and have their own test runner.
    include: ['apps/**/*.spec.ts', 'libs/**/*.spec.ts', 'tools/**/*.spec.ts'],
  },
});
