import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { newBluePixels } from './pixels.mjs';

if (!process.env.LIVESEED_DSH_ROOT) throw new Error('Set LIVESEED_DSH_ROOT.');
await mkdir('.local', { recursive: true });
const folder = await mkdtemp(resolve('.local/character-acceptance-'));
const port = await new Promise((done, reject) => { const server = createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => done(port)); }); });
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [join(resolve(process.env.LIVESEED_DSH_ROOT), 'lib/bin.js'), '--profile', 'liveseed-character-acceptance', '--from-default-profile', 'web', '--patch', resolve('examples/acceptance.cordis.patch.yml'), '--port', String(port), '--no-open'], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: resolve('.'),
  env: { ...process.env, DSH_HOME: join(folder, 'home'), LIVESEED_TEST_DATA: join(folder, 'companion'), LIVESEED_TEST_CHARACTER_DIR: resolve(process.env.LIVESEED_CHARACTER_DIR ?? 'CharacterModel') },
});
let output = '', browser;
const errors = [], consoleErrors = [];
const hostOutput = data => { output += String(data); appendFileSync(join(folder, 'host.log'), data); };
child.stdout.on('data', hostOutput); child.stderr.on('data', hostOutput);
try {
  const until = Date.now() + 60000;
  let login;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error('Isolated DSH startup failed; inspect private logs.');
    const urls = output.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+[^\s\x1b]*/g) ?? [];
    login = [...urls].reverse().find(value => value.startsWith(base) && value.includes('?'));
    if (login) break;
    await delay(200);
  }
  assert.ok(login, 'authenticated DSH startup URL');
  const anonymous = await fetch(`${base}/api/liveseed/character-resource?id=${'0'.repeat(64)}`);
  assert.ok([401, 403].includes(anonymous.status), 'native transport rejects unauthenticated asset requests');
  browser = await chromium.launch({ executablePath: process.env.LIVESEED_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 920 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', event => { if (event.type() === 'error' || event.type() === 'warning') { consoleErrors.push(event.text()); appendFileSync(join(folder, 'console.log'), event.text()+'\n'); } });
  await page.goto(login);
  const preview = page.getByText('预览版说明', { exact: true });
  if (await preview.isVisible()) await page.getByRole('button', { name: '继续', exact: true }).click();
  const canvas = page.locator('canvas[data-character-canvas]');
  try { await page.locator('canvas[data-character-ready="true"]').waitFor({ timeout: 90000 }); }
  catch { await page.screenshot({ path: join(folder, 'failure.png') }); throw new Error('Character load timed out; inspect private browser/host logs.'); }
  assert.equal(await canvas.count(), 1);
  process.stdout.write('Native PMX renderer ready; checking model channels.\n');
  assert.equal(await canvas.getAttribute('data-character-bones'), '493');
  assert.equal(await canvas.getAttribute('data-character-morphs'), '84');
  assert.equal(await canvas.getAttribute('data-character-material-morphs'), '3');
  if (await preview.isVisible()) await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.screenshot({ path: join(folder, 'native.png') });
  await page.evaluate(() => { window.__characterAcceptanceCanvas = document.querySelector('canvas[data-character-canvas]'); });
  const stage = page.getByRole('region', { name: '德谬歌常驻角色', exact: true });
  assert.equal(await stage.evaluate(element => getComputedStyle(element).pointerEvents), 'none');
  await page.getByRole('button', { name: '德谬歌', exact: true }).click();
  await page.getByRole('button', { name: '德谬歌设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '德谬歌设置', exact: true });
  await settings.getByRole('button', { name: '角色', exact: true }).click();
  await settings.getByText('模型已加载', { exact: true }).waitFor();
  const size = settings.getByLabel('显示大小', { exact: true });
  assert.equal(await size.getAttribute('min'), '0.25'); assert.equal(await size.getAttribute('max'), '6');
  await settings.getByRole('button', { name: '上半身构图', exact: true }).click();
  const cropped = await stage.boundingBox();
  assert.ok(cropped.y + cropped.height > 920 && cropped.height > 920, 'upper-body framing allows the lower body outside the page');
  const handle = page.getByRole('button', { name: '移动德谬歌角色', exact: true });
  const grip = await handle.boundingBox();
  assert.ok(Math.abs(grip.y-cropped.y)<2, 'drag handle is above the character');
  const pixels = await canvas.evaluate(element => ({ w: element.width, h: element.height, viewport: innerHeight }));
  assert.ok(pixels.h <= pixels.viewport*1.5+2, 'offscreen body pixels do not allocate an oversized drawing buffer');
  await page.getByRole('button', { name: '关闭德谬歌设置', exact: true }).click();
  await page.screenshot({ path: join(folder, 'upper-body.png') });
  const startGrip = await handle.boundingBox();
  await page.mouse.move(startGrip.x+16,startGrip.y+12); await page.mouse.down(); await page.mouse.move(startGrip.x-34,startGrip.y+92,{steps:6}); await page.mouse.up();
  const moved = await handle.boundingBox(); assert.ok(moved.y > startGrip.y+50, 'top handle can move a clipped body');
  await page.getByRole('button', { name: '德谬歌设置', exact: true }).click();
  await settings.getByRole('button', { name: '恢复位置和大小', exact: true }).click();
  await settings.getByRole('button', { name: '重新加载角色', exact: true }).click();
  await page.waitForFunction(() => {
    const next = document.querySelector('canvas[data-character-ready="true"]');
    return next && next !== window.__characterAcceptanceCanvas;
  });
  assert.equal(await canvas.count(), 1, 'reload disposes the previous canvas');
  await page.waitForFunction(() => Number(document.querySelector('canvas[data-character-canvas]')?.dataset.characterFps)>45, undefined, { timeout: 15000 });
  const performanceWithoutPhysics = await canvas.evaluate(element => ({ fps: Number(element.dataset.characterFps), updateMs: Number(element.dataset.characterUpdateMs), renderMs: Number(element.dataset.characterRenderMs) }));
  await page.evaluate(() => { window.__characterAcceptanceCanvas = document.querySelector('canvas[data-character-canvas]'); });
  const morph = settings.getByLabel('表情预览', { exact: true });
  const names = await morph.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean));
  assert.equal(names.length, 84);
  for (const name of names) {
    await morph.selectOption(name);
    await page.waitForFunction(name => { const data = document.querySelector('canvas[data-character-canvas]')?.dataset; return data?.characterMorphWeight === '1' && data.characterMorphName === name; }, name);
  }
  await morph.selectOption('照れ');
  await page.waitForFunction(() => Number(document.querySelector('canvas[data-character-canvas]')?.dataset.characterMaterialChange) > 0);
  const materialChange = Number(await canvas.getAttribute('data-character-material-change'));
  await settings.getByRole('button', { name: '清除表情', exact: true }).click();
  await page.waitForFunction(() => Number(document.querySelector('canvas[data-character-canvas]')?.dataset.characterMaterialChange) === 0);
  // MMD symbol Morphs (汗 / ！ / ？) move a hidden quad out of the hair, so they need the full
  // preview weight. Verify the pixels, not only the written influence: the previous 0.5 default
  // applied the weight while the drop stayed behind the hair.
  await page.getByRole('button', { name: '关闭德谬歌设置', exact: true }).click();
  await delay(500);
  const cleanShot = await stage.screenshot();
  await page.getByRole('button', { name: '德谬歌设置', exact: true }).click();
  await settings.getByLabel('表情预览', { exact: true }).selectOption('汗');
  await delay(800);
  await page.getByRole('button', { name: '关闭德谬歌设置', exact: true }).click();
  await delay(500);
  const symbolShot = await stage.screenshot();
  const symbolPixels = newBluePixels(cleanShot, symbolShot);
  assert.ok(symbolPixels >= 20, 'displacement symbol Morph is visible at the default preview weight, new blue pixels=' + symbolPixels);
  await page.screenshot({ path: join(folder, 'symbol-morph.png') });
  await page.getByRole('button', { name: '德谬歌设置', exact: true }).click();
  await settings.getByRole('button', { name: '清除表情', exact: true }).click();
  for (const label of ['轻点头', '轻挥手', '身体侧倾', '重心移动', '腿部轻摆']) {
    await settings.getByRole('button', { name: label, exact: true }).click(); await delay(100);
  }
  await settings.getByRole('button', { name: '停止动作', exact: true }).click();
  await delay(500);
  await settings.getByRole('button', { name: '重置姿态', exact: true }).click();
  assert.equal(await canvas.getAttribute('data-character-finite'), 'true');
  process.stdout.write('All native Morphs checked; checking optional physics.\n');
  await settings.getByLabel('头发与服装物理', { exact: true }).check();
  await page.waitForFunction(() => document.querySelector('canvas[data-character-canvas]')?.dataset.characterPhysics === 'true', undefined, { timeout: 30000 });
  await settings.getByRole('button', { name: '轻挥手', exact: true }).click();
  await delay(3500);
  const performanceWithPhysics = await canvas.evaluate(element => ({ fps: Number(element.dataset.characterFps), updateMs: Number(element.dataset.characterUpdateMs), renderMs: Number(element.dataset.characterRenderMs), mode: element.dataset.characterPhysicsMode, projection: JSON.parse(element.dataset.characterProjection ?? '{}') }));
  assert.equal(performanceWithPhysics.mode, 'worker', 'physics runs in the browser Worker');
  assert.equal(performanceWithPhysics.projection.batched, true);
  assert.ok(performanceWithPhysics.projection.checks >= 3 && performanceWithPhysics.projection.positionError < 1e-6 && performanceWithPhysics.projection.angleError < 1e-5 && performanceWithPhysics.projection.baseError < 1e-6, 'batched projection agrees with upstream bone and state outputs during motion');
  assert.equal(await canvas.getAttribute('data-character-finite'), 'true');
  await page.screenshot({ path: join(folder, 'physics.png') });
  await settings.getByLabel('头发与服装物理', { exact: true }).uncheck();
  const before = Number(await canvas.getAttribute('data-character-frames'));
  await settings.getByLabel('显示角色', { exact: true }).uncheck();
  await delay(300);
  const hidden = Number(await canvas.getAttribute('data-character-frames'));
  assert.ok(hidden <= before + 2, 'hidden stage pauses rendering');
  await settings.getByLabel('显示角色', { exact: true }).check();
  await page.waitForFunction(previous => Number(document.querySelector('canvas[data-character-canvas]')?.dataset.characterFrames) > previous, hidden);
  await page.getByRole('button', { name: '关闭德谬歌设置', exact: true }).click();
  await page.getByText('新会话', { exact: true }).first().click();
  assert.equal(await canvas.count(), 1, 'ordinary workspace navigation retains the global stage');
  assert.ok(await page.evaluate(() => document.querySelector('canvas[data-character-canvas]') === window.__characterAcceptanceCanvas));
  await page.getByRole('button', { name: '德谬歌', exact: true }).click();
  await page.getByRole('button', { name: '记忆整理会话', exact: true }).click();
  await page.getByRole('navigation', { name: '记忆整理会话列表' }).getByRole('button').first().click();
  assert.ok(await page.evaluate(() => document.querySelector('canvas[data-character-canvas]') === window.__characterAcceptanceCanvas), 'session navigation keeps the same renderer');
  await page.screenshot({ path: join(folder, 'character.png') });
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  assert.ok(!consoleErrors.some(line => /shader error|shader_error|error validating|compilation failed/i.test(line)), 'no shader failures');
  await writeFile(join(folder, 'result.json'), JSON.stringify({ bones: 493, morphs: names.length, materialMorphs: 3, materialChange, symbolMorphPixels: symbolPixels, performanceWithoutPhysics, performanceWithPhysics, errors, consoleErrors, realModelCalls: 0, actualPmxLoaded: true }, null, 2));
  process.stdout.write(`Character acceptance passed. Private artifacts: ${folder}\n`);
} finally {
  await writeFile(join(folder, 'host.log'), output);
  await writeFile(join(folder, 'browser.json'), JSON.stringify({ errors, consoleErrors }, null, 2));
  await browser?.close();
  if (child.exitCode === null) { const stopped = new Promise(done => child.once('exit', done)); child.kill('SIGTERM'); await Promise.race([stopped, delay(5000)]); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}
