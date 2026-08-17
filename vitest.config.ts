import { defineConfig } from 'vitest/config';

import { INSTANCE, INSTANCE_TITLE, instanceAlias } from './instance.config';

export default defineConfig({
  // Rayfin entities use TC39 Stage 3 decorators, so the test transform must
  // target ES2022 like the app build does.
  esbuild: { target: 'es2022' },
  // The same alias the app build uses — tests import `@instance` through the
  // identical path, so a test can never pass against a schema the app would
  // not load.
  resolve: { alias: instanceAlias },
  define: {
    __APP_INSTANCE__: JSON.stringify(INSTANCE),
    __APP_TITLE__: JSON.stringify(INSTANCE_TITLE),
  },
  test: { environment: 'node', include: ['**/*.test.ts'] },
});
