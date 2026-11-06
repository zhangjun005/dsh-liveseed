import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

if (!process.env.LIVESEED_DSH_ROOT) throw new Error('Set LIVESEED_DSH_ROOT to the installed DSH package directory.');
const dshRoot = resolve(process.env.LIVESEED_DSH_ROOT);
const cli = join(dshRoot, 'lib', 'bin.js');
await mkdir(resolve('.local'), { recursive: true });
const folder = await mkdtemp(join(resolve('.local'), 'web-acceptance-'));
const port = await new Promise((resolvePort, reject) => {
  const socket = createServer(); socket.on('error', reject);
  socket.listen(0, '127.0.0.1', () => { const value = socket.address().port; socket.close(() => resolvePort(value)); });
});
const base = `http://127.0.0.1:${port}`;
let child, output = '', browser;
const errors = [];
async function start(fresh) {
  output = '';
  const args = [cli, '--profile', 'liveseed-acceptance', ...(fresh ? ['--from-default-profile', 'web'] : []), '--patch', resolve('examples/acceptance.cordis.patch.yml'), '--port', String(port), '--no-open'];
  child = spawn(process.execPath, args, { cwd: resolve('.'), windowsHide: true, env: { ...process.env, DSH_HOME: join(folder, 'home'), LIVESEED_TEST_DATA: join(folder, 'companion') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`DSH exited during startup (${child.exitCode}); inspect the local acceptance log.`);
    try { const res = await fetch(`${base}/liveseed/api/state`, { headers: { 'x-liveseed-request': '1' } }); if (res.status === 401 || res.status === 403) return; } catch {}
    await delay(200);
  }
  throw new Error('Isolated DSH startup timed out; inspect the local acceptance log.');
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(8000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([exited, delay(4000)]); }
}
async function openCompanion(page) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const preview = page.getByText('预览版说明', { exact: true });
    if (await preview.isVisible()) await page.getByRole('button', { name: '继续', exact: true }).click();
    try {
      await page.getByRole('button', { name: '德谬歌', exact: true }).click({ timeout: 1000 });
      await page.getByRole('region', { name: '德谬歌陪伴面板', exact: true }).waitFor({ timeout: 2000 });
      return;
    } catch { await delay(100); }
  }
  throw new Error('Companion panel could not be opened after startup.');
}
try {
  await start(true);
  await writeFile(join(folder, 'host-startup.log'), output);
  const anonymous = await fetch(`${base}/liveseed/api/state`, { headers: { 'x-liveseed-request': '1' } });
  assert.ok([401, 403].includes(anonymous.status), 'anonymous requests must be rejected');
  const anonymousMemory = await fetch(`${base}/liveseed/api/memory-state`, { headers: { 'x-liveseed-request': '1' } });
  assert.ok([401, 403].includes(anonymousMemory.status));
  browser = await chromium.launch({ executablePath: process.env.LIVESEED_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 920 } });
  page.on('pageerror', error => errors.push(error.message));
  const candidates = output.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+[^\s\x1b]*/g) ?? [];
  const login = [...candidates].reverse().find(value => value.startsWith(base) && value.includes('?'));
  if (!login) throw new Error('No authenticated startup URL found; inspect the local acceptance log.');
  await page.goto(login);
  await openCompanion(page);
  await page.getByRole('region', { name: '德谬歌陪伴面板', exact: true }).waitFor();
  await page.getByLabel('给德谬歌的消息').fill('你好，记住这句浏览器验收消息。');
  await page.getByRole('button', { name: /发送/ }).click();
  await page.getByText('我在。你刚才说：“你好，记住这句浏览器验收消息。”。', { exact: true }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: '整理记忆', exact: true }).click();
  await page.getByLabel('给整理线的消息').fill('整理这段验收记忆');
  await page.getByRole('button', { name: /发送/ }).click();
  await page.getByText('这次整理已完成。', { exact: true }).waitFor({ timeout: 15000 });
  await page.screenshot({ path: join(folder, 'memory.png'), fullPage: true });
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await page.getByText('我在。你刚才说：“你好，记住这句浏览器验收消息。”。', { exact: true }).waitFor();
  assert.equal(await page.getByText('整理这段验收记忆', { exact: true }).count(), 0, 'maintenance dialogue must not enter main chat');
  const rows = await page.evaluate(async () => {
    const res = await fetch('/api/session/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/list', payload: { args: { _request: {} } } }) });
    return { status: res.status, text: await res.text() };
  });
  await writeFile(join(folder, 'native-session-list.json'), rows.text);
  assert.equal(rows.status, 200);
  const nativeListEnvelope = JSON.parse(rows.text);
  assert.equal(nativeListEnvelope.result.ok, true, 'native list RPC must succeed');
  const nativeList = nativeListEnvelope.result.value.items;
  assert.ok(Array.isArray(nativeList), 'the native list endpoint must return its real Session array');
  assert.ok(!nativeList.some(row => row.sessionId === 'liveseed-main' || row.id === 'liveseed-main'));
  assert.ok(!JSON.stringify(nativeList).includes('liveseed-memory'));
  const nativeSearch = await page.evaluate(async () => {
    const res = await fetch('/api/session/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/search', payload: { args: { request: { query: '浏览器验收消息' } } } }) });
    return { status: res.status, text: await res.text() };
  });
  await writeFile(join(folder, 'native-session-search.json'), nativeSearch.text);
  assert.equal(nativeSearch.status, 200);
  const searchEnvelope = JSON.parse(nativeSearch.text);
  assert.equal(searchEnvelope.result.ok, true, 'native search RPC must succeed');
  const searchValue = searchEnvelope.result.value;
  assert.ok(Array.isArray(searchValue.items), 'the native search endpoint must return its real search results');
  assert.ok(!JSON.stringify(searchValue).includes('liveseed-main'));
  await page.screenshot({ path: join(folder, 'conversation.png'), fullPage: true });
  const unauthorized = await page.evaluate(async () => ({
    missingHeader: (await fetch('/liveseed/api/state')).status,
    memoryMissingHeader: (await fetch('/liveseed/api/memory-state')).status,
    foreignSession: (await fetch('/liveseed/api/send', { method: 'POST', headers: { 'content-type': 'application/json', 'x-liveseed-request': '1' }, body: JSON.stringify({ requestId: crypto.randomUUID(), text: 'invalid', sessionId: 'ordinary-session' }) })).status,
  }));
  assert.equal(unauthorized.missingHeader, 403); assert.equal(unauthorized.foreignSession, 400);
  assert.equal(unauthorized.memoryMissingHeader, 403);
  await stop(); await start(false);
  const newCandidates = output.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+[^\s\x1b]*/g) ?? [];
  const newLogin = [...newCandidates].reverse().find(value => value.startsWith(base) && value.includes('?'));
  await page.goto(newLogin ?? base);
  await openCompanion(page);
  await page.getByText('我在。你刚才说：“你好，记住这句浏览器验收消息。”。', { exact: true }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: '整理记忆', exact: true }).click();
  await page.getByText('这次整理已完成。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await page.getByLabel('给德谬歌的消息').waitFor();
  await page.getByLabel('给德谬歌的消息').fill('停一下，这是一段需要停止的回复。');
  await page.getByRole('button', { name: /发送/ }).click();
  await page.getByRole('button', { name: '停止', exact: true }).click({ timeout: 10000 });
  await page.getByText('这次回复已停止。', { exact: true }).waitFor();
  await page.setViewportSize({ width: 430, height: 900 });
  await page.screenshot({ path: join(folder, 'mobile.png'), fullPage: true });
  assert.deepEqual(errors, [], 'browser must not report uncaught errors');
  await writeFile(join(folder, 'result.json'), JSON.stringify({ passed: true, anonymous: anonymous.status, anonymousMemory: anonymousMemory.status, ...unauthorized, memoryChatWorked: true, memoryChatRestored: true, restartRestored: true, stopWorked: true, browserErrors: errors, nativeListExcludesCompanion: true, nativeSearchExcludesCompanion: true, realModelCalls: 0 }, null, 2));
  console.log(`Browser acceptance passed. Artifacts: ${folder}`);
} catch (error) {
  const failedPage = browser?.contexts()[0]?.pages()[0];
  await failedPage?.screenshot({ path: join(folder, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(join(folder, 'failure.json'), JSON.stringify({ error: error.message, browserErrors: errors }, null, 2));
  console.error(`${error.message}\nAcceptance artifacts: ${folder}`); process.exitCode = 1;
} finally { await browser?.close(); await stop(); await writeFile(join(folder, 'host-last.log'), output); }
