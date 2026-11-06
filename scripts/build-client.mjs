import { build } from 'esbuild';
// DSH loads browser plugins through its own ModuleLoader, not native ESM script tags.
await build({ entryPoints: ['src/client/index.tsx'], outfile: 'dist/client.js', bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2022', sourcemap: true,
  external: ['react', 'react/jsx-runtime'],
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-liveseed", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
});
