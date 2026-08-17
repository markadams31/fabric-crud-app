import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

import { INSTANCE, INSTANCE_TITLE, instanceAlias } from './instance.config';

export default defineConfig(({ mode }) => {
  // Pin the dev server to the port Rayfin allocated (VITE_PORT, from
  // RAYFIN_PUBLIC_FRONTEND_PORT). The deployed backend allow-lists exactly one
  // origin, so a port fallback would silently break the sign-in redirect.
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const port = env.VITE_PORT ? Number(env.VITE_PORT) : undefined;


  return {
    // `@vitejs/plugin-react` (esbuild), NOT plugin-react-swc: SWC cannot compile
    // Rayfin's TC39 decorators regardless of `target`, and fails only in the dev
    // server — `vite build` succeeds, so a build passing proves nothing here.
    plugins: [
      react(),
      // The browser tab. `index.html` is static, so without this every instance
      // ships the same hard-coded <title> — the defect the <h1> already had.
      // Substituted at build time rather than assigned from script, so the tab
      // is right before React mounts and never flashes the wrong name.
      {
        name: 'app-title',
        transformIndexHtml: (html: string) =>
          html.replace(/<title>[^<]*<\/title>/, `<title>${INSTANCE_TITLE}</title>`),
      },
    ],
    resolve: { alias: instanceAlias },
    // The app's own name. Every instance showed the same hard-coded heading,
    // so four different apps looked like one. Not read from entity metadata —
    // it is a property of the deployment, not of any table.
    define: {
      __APP_INSTANCE__: JSON.stringify(INSTANCE),
      __APP_TITLE__: JSON.stringify(INSTANCE_TITLE),
    },
    ...(port ? { server: { port, strictPort: true } } : {}),
    // es2022 everywhere: entities use TC39 decorators and Symbol.metadata.
    build: { target: 'es2022' },
    // keepNames as well as the source aliases above: an entity's identity IS
    // its class name, so anything that renames classes silently rewires the
    // schema. Belt and braces — the aliases keep today's classes readable,
    // this keeps a future tsc-built entity package from repeating the bug.
    esbuild: { target: 'es2022', keepNames: true },
    optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  };
});
