import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
// Version-specific adapter: reuse the upstream bar AND its editor runtime together.
// Never load upstream apply() twice or bind the private companion to ordinary Sessions.
const upstream = await readFile(require.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8');
const expected = '8d5c8223197d52d69eb0587f88a8a051fc172985553915f1de361544653a68b0';
if (createHash('sha256').update(upstream).digest('hex') !== expected) throw new Error('Native composer bundle changed; review the pinned adapter before upgrading DSH.');
const native = upstream.replace('id: "@deepseek-ai/dsh-client-ui-conversation"', 'id: "dsh-liveseed-native-composer"')
  .replace('return module.exports;', 'exports.LiveSeedInputBar = InputBar; exports.LiveSeedInputShell = SessionInputShell; return module.exports;')
  .replace('//# sourceMappingURL=client.js.map', '');
const license = await readFile(require.resolve('@deepseek-ai/dsh-client-ui-conversation/package.json').replace(/package\.json$/, 'LICENSE'), 'utf8');
await writeFile('dist/NATIVE-COMPOSER-LICENSE.txt', license);
// DSH loads browser plugins through its own ModuleLoader, not native ESM script tags.
await build({ entryPoints: ['src/client/index.tsx'], outfile: 'dist/client.js', bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2022', sourcemap: true,
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis', 'dsh-liveseed-native-composer', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-api-gateway/client'],
  banner: { js: `/*! Native composer: @deepseek-ai/dsh-client-ui-conversation 0.2.0-rc.2; MIT; Copyright (c) 2026 DeepSeek. See NATIVE-COMPOSER-LICENSE.txt. */\n${native}\nwindow.__ModuleLoader__.load({ id: "dsh-liveseed", factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
});
