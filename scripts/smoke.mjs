import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';

// Exercises real Cordis discovery + mount/unmount of the built package. No model/API.
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const pluginUrl = new URL('../dist/index.js', import.meta.url);
const plugin = await import(pluginUrl.href);
assert.equal(plugin.name, manifest.name);
assert.equal(typeof plugin.apply, 'function');

const root = new Context();
try {
  await root.plugin(Loader, { baseUrl: new URL('../', import.meta.url).href });
  const id = await root.loader.create({
    id: 'liveseed-smoke',
    name: pluginUrl.href,
  });
  await root.loader.await();
  const entry = root.loader.resolve(id);
  assert.ok(entry?.fiber, 'loader must create a plugin fiber');
  assert.ok(root.registry.has(plugin), 'plugin must be registered');
  assert.equal(typeof plugin.Config.parse, 'function');
  assert.throws(() => plugin.Config.parse({ stateDir: 'relative/path' }));
  assert.equal(root.get('liveseed'), undefined, 'missing host services must not start companion behavior');
  const fiber = entry.fiber;
  root.loader.remove(id);
  await fiber.dispose();
  await root.loader.await();
  assert.equal(root.registry.has(plugin), false, 'plugin must be unregistered after removal');
  console.log('LiveSeed smoke passed: entry discovered, config validated, host dependencies fail closed, unload completed.');
} finally {
  await root.fiber.dispose();
}
