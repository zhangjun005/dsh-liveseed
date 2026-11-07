import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { seedCompanionHistory } from './seed-session.mjs';

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
const legacyRequests = [];
let followFrames = 0;
async function start(fresh) {
  output = '';
  const args = [cli, '--profile', 'liveseed-acceptance', ...(fresh ? ['--from-default-profile', 'web'] : []), '--patch', resolve('examples/acceptance.cordis.patch.yml'), '--port', String(port), '--no-open'];
  child = spawn(process.execPath, args, { cwd: resolve('.'), windowsHide: true, env: { ...process.env, DSH_HOME: join(folder, 'home'), LIVESEED_TEST_DATA: join(folder, 'companion'), LIVESEED_TEST_CHARACTER_DIR: join(folder, 'no-character') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`DSH exited during startup (${child.exitCode}); inspect the local acceptance log.`);
    try { const res = await fetch(`${base}/api/liveseed/catalog`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); if (res.status === 401 || res.status === 403) return; } catch {}
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
async function openSettings(page) {
  await page.getByRole('button', { name: '德谬歌设置', exact: true }).click();
  await page.waitForFunction(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="德谬歌设置"]');
    return dialog && getComputedStyle(dialog).opacity === '1';
  });
}
async function openMemory(page, title = '记忆整理') {
  await page.getByRole('button', { name: '记忆整理会话', exact: true }).click();
  await page.getByRole('navigation', { name: '记忆整理会话列表' }).getByRole('button', { name: `打开 ${title}`, exact: true }).click();
}
try {
  await seedCompanionHistory(join(folder, 'companion'));
  await start(true);
  await writeFile(join(folder, 'host-startup.log'), output);
  const anonymous = await fetch(`${base}/api/liveseed/catalog`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.ok([401, 403].includes(anonymous.status), 'anonymous requests must be rejected');
  browser = await chromium.launch({ executablePath: process.env.LIVESEED_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 920 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/liveseed/api/')) legacyRequests.push(request.url()); });
  page.on('websocket', socket => socket.on('framesent', frame => { if (typeof frame.payload === 'string' && frame.payload.includes('liveseed/follow')) followFrames++; }));
  const candidates = output.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+[^\s\x1b]*/g) ?? [];
  const login = [...candidates].reverse().find(value => value.startsWith(base) && value.includes('?'));
  if (!login) throw new Error('No authenticated startup URL found; inspect the local acceptance log.');
  await page.goto(login);
  await openCompanion(page);
  await page.getByRole('region', { name: '德谬歌陪伴面板', exact: true }).waitFor();
  const editor = page.getByLabel('给德谬歌的消息');
  await editor.fill('第一行'); await editor.press('End'); await editor.press('Shift+Enter');
  await page.keyboard.insertText('第二行');
  assert.match(await editor.innerText(), /第一行\n第二行/, 'native Shift+Enter must insert a newline');
  await editor.press('Control+z');
  assert.ok(!(await editor.innerText()).includes('第二行'), 'native undo must undo the last editor input');
  await editor.fill('测'.repeat(6001)); await editor.press('Enter');
  await page.getByRole('alert').filter({ hasText: '消息请保持在 1–6000 字以内。' }).waitFor();
  await page.waitForFunction(() => document.querySelector('[data-lexical-editor="true"]')?.textContent?.length === 6001);
  await editor.fill('你好，记住这句浏览器验收消息。');
  await editor.press('Enter');
  await page.getByText('我在。你刚才说：“你好，记住这句浏览器验收消息。”。', { exact: true }).waitFor({ timeout: 15000 });
  const panel = page.getByRole('region', { name: '德谬歌陪伴面板' });
  assert.equal(await panel.locator('textarea').count(), 0, 'must mount the real native editor');
  assert.equal(await panel.locator('[data-lexical-editor="true"]').count(), 1);
  const toggle = page.getByRole('button', { name: '聊天会话', exact: true });
  const box = await toggle.boundingBox(); const bounds = await panel.boundingBox();
  assert.ok(box.x > bounds.x + bounds.width - 80 && box.y < bounds.y + 70, 'floating toggle belongs at the top right');
  assert.equal(await toggle.evaluate(el => getComputedStyle(el).borderRadius), '50%');
  assert.match(await toggle.evaluate(el => getComputedStyle(el).getPropertyValue('corner-shape')), /^(round|superellipse\(1\))$/);
  const memoryBox = await page.getByRole('button', { name: '记忆整理会话', exact: true }).boundingBox();
  assert.equal(memoryBox.x, box.x); assert.ok(memoryBox.y > box.y + box.height, 'memory button must sit below chat button');
  assert.equal(box.width, box.height); assert.equal(memoryBox.width, memoryBox.height);
  const settingsButton = page.getByRole('button', { name: '德谬歌设置', exact: true });
  const settingsBox = await settingsButton.boundingBox();
  assert.equal(settingsBox.x, memoryBox.x); assert.ok(settingsBox.y > memoryBox.y + memoryBox.height);
  assert.equal(settingsBox.width, settingsBox.height);
  await openMemory(page);
  await page.getByLabel('给整理线的消息').waitFor();
  assert.equal(await page.getByLabel('新整理会话名称').count(), 0, 'session navigation does not embed assignment');
  assert.equal(await page.getByRole('button', { name: '指定', exact: true }).count(), 0);
  await toggle.click();
  await page.getByRole('navigation', { name: '聊天会话列表' }).getByRole('button', { name: '聊天', exact: true }).click();
  await toggle.click(); await page.keyboard.press('Escape');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await toggle.click(); await panel.getByRole('log').click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  const navigation = page.getByRole('navigation', { name: '聊天会话列表' });
  const settings = page.getByRole('dialog', { name: '德谬歌设置' });
  await page.getByRole('button', { name: '聊天会话', exact: true }).click();
  await navigation.getByRole('button', { name: /^聊天 \d/ }).nth(1).click();
  await page.getByText('昨日的陪伴记录', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('给德谬歌的消息').isVisible(), false, 'old daily sessions must be read-only');
  assert.equal(await page.getByText('你好，记住这句浏览器验收消息。', { exact: true }).count(), 0, 'historical views must show only their own native segment');
  await page.getByRole('button', { name: '聊天会话', exact: true }).click();
  await navigation.getByRole('button', { name: '聊天', exact: true }).click();
  await page.getByText('我在。你刚才说：“你好，记住这句浏览器验收消息。”。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const increaseFont = page.getByRole('button', { name: '增大字号', exact: true });
  await increaseFont.waitFor();
  for (let i = 0; i < 4; i++) await increaseFont.click();
  await page.keyboard.press('Escape');
  await page.getByLabel('给德谬歌的消息').waitFor();
  assert.equal(await page.locator('.ls-user .ls-bubble').last().evaluate(el => getComputedStyle(el).fontSize), '18px');
  assert.equal(await page.locator('.ls-assistant .ls-bubble p').last().evaluate(el => getComputedStyle(el).fontSize), '18px');
  assert.equal(await page.getByLabel('给德谬歌的消息').evaluate(el => getComputedStyle(el).fontSize), '18px');
  await page.getByLabel('给德谬歌的消息').fill('主线未发送的草稿');
  await openMemory(page);
  assert.equal(await page.getByLabel('给整理线的消息').innerText(), '', 'main draft must not enter the memory composer');
  await page.getByLabel('给整理线的消息').fill('整理这段验收记忆');
  await page.getByRole('button', { name: /发送/ }).click();
  await page.getByText('这次整理已完成。', { exact: true }).waitFor({ timeout: 15000 });
  await page.screenshot({ path: join(folder, 'memory.png'), fullPage: true });
  await page.getByRole('button', { name: '聊天会话', exact: true }).click();
  await navigation.getByRole('button', { name: '聊天', exact: true }).click();
  await page.getByText('我在。你刚才说：“你好，记住这句浏览器验收消息。”。', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('给德谬歌的消息').innerText(), '主线未发送的草稿');
  assert.equal(await page.getByText('消息请保持在 1–6000 字以内。', { exact: true }).count(), 0, 'successful resend must not replay an old composer error after switching Sessions');
  assert.equal(await page.getByRole('region', { name: '德谬歌陪伴面板' }).getByRole('button', { name: /权限|permission|完全访问/i }).count(), 0);
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
  const unauthorized = await page.evaluate(async () => {
    const rpc = async (method, request) => (await (await fetch(`/api/liveseed/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: `liveseed/${method}`, payload: { args: { request } } }) })).json()).result;
    return { foreignSession: await rpc('snapshot', { sessionId: 'ordinary-session' }),
      foreignSend: await rpc('send', { requestId: crypto.randomUUID(), text: 'invalid', sessionId: 'ordinary-session' }),
      extraFields: await rpc('send', { requestId: crypto.randomUUID(), text: 'invalid', sessionId: 'current', cwd: 'E:/' }) };
  });
  assert.equal(unauthorized.foreignSession.ok, false); assert.equal(unauthorized.foreignSend.ok, false); assert.equal(unauthorized.extraFields.ok, false);
  await page.getByLabel('给德谬歌的消息').fill('宿主重启后保留这份草稿');
  const beforeRestart = followFrames;
  await stop(); await start(false);
  const reconnectUntil = Date.now() + 20000;
  while (Date.now() < reconnectUntil && followFrames <= beforeRestart) await delay(100);
  assert.ok(followFrames > beforeRestart, 'the existing page must reopen its native follow stream without reloading');
  assert.equal(await page.getByLabel('给德谬歌的消息').innerText(), '宿主重启后保留这份草稿');
  await page.getByText('我在。你刚才说：“你好，记住这句浏览器验收消息。”。', { exact: true }).waitFor({ timeout: 15000 });
  await openMemory(page);
  await page.getByText('这次整理已完成。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '聊天会话', exact: true }).click();
  await navigation.getByRole('button', { name: '聊天', exact: true }).click();
  await openSettings(page);
  await page.getByLabel('新整理会话名称').fill('新的长期整理会话');
  await page.getByRole('button', { name: '新建并指定', exact: true }).click();
  await settings.getByText('已指定整理 Session。', { exact: true }).waitFor();
  assert.equal(await settings.getByLabel('soul.md 路径', { exact: true }).innerText(), join(folder, 'companion', 'soul.md'));
  assert.equal(await settings.getByLabel('narrative.md 路径', { exact: true }).innerText(), join(folder, 'companion', 'narrative.md'));
  assert.equal(await settings.getByLabel('soul.md 路径', { exact: true }).evaluate(el => getComputedStyle(el).userSelect), 'all');
  assert.equal(await settings.getByLabel('soul.md 路径', { exact: true }).evaluate(el => el.isContentEditable || ['INPUT', 'TEXTAREA'].includes(el.tagName)), false);
  const modalBounds = await settings.boundingBox();
  assert.ok(modalBounds.width >= 700 && modalBounds.height >= 650, 'settings uses a full-sized native modal');
  assert.ok(Math.abs(modalBounds.x + modalBounds.width / 2 - 680) < 2, 'modal is centered in the browser');
  assert.equal(await settings.getByRole('navigation', { name: '德谬歌设置分类' }).isVisible(), true);
  assert.equal(await page.getByLabel('给德谬歌的消息').isVisible(), true, 'assigning through settings must not switch the current conversation');
  await page.screenshot({ path: join(folder, 'settings.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await openMemory(page, '新的长期整理会话');
  await page.getByText('想怎样整理这些记忆？', { exact: true }).waitFor();
  assert.equal(await page.getByText('整理这段验收记忆', { exact: true }).count(), 0);
  await page.getByLabel('给整理线的消息').fill('由新会话承担整理');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText('这次整理已完成。', { exact: true }).waitFor();
  const beforeWorkerRestart = followFrames;
  await stop(); await start(false);
  const workerReconnectUntil = Date.now() + 20000;
  while (Date.now() < workerReconnectUntil && followFrames <= beforeWorkerRestart) await delay(100);
  assert.ok(followFrames > beforeWorkerRestart);
  await page.getByRole('alert').filter({ hasText: '连接中断' }).waitFor({ state: 'hidden' });
  await openSettings(page);
  await settings.getByRole('option', { name: '新的长期整理会话（当前）', exact: true }).waitFor({ state: 'attached', timeout: 20000 });
  await page.screenshot({ path: join(folder, 'session-selector.png'), fullPage: true });
  await settings.getByLabel('整理任务会话', { exact: true }).selectOption({ label: '记忆整理' });
  assert.equal(await page.getByText('由新会话承担整理', { exact: true }).isVisible(), true, 'choosing a candidate must not assign it before confirmation');
  await settings.getByRole('button', { name: '指定', exact: true }).click();
  await settings.getByText('已指定整理 Session。', { exact: true }).waitFor();
  assert.equal(await page.getByText('由新会话承担整理', { exact: true }).isVisible(), true, 'assignment must not navigate away from the Session being viewed');
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });
  await openMemory(page);
  await page.getByText('整理这段验收记忆', { exact: true }).waitFor();
  assert.equal(await page.getByText('由新会话承担整理', { exact: true }).count(), 0);
  await openMemory(page, '新的长期整理会话');
  await page.getByLabel('给整理线的消息').fill('未承担后台任务也能继续对话');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText('未承担后台任务也能继续对话', { exact: true }).waitFor();
  await page.getByText('这次整理已完成。', { exact: true }).last().waitFor();
  await page.getByLabel('给整理线的消息').fill('新会话自己的草稿');
  await openMemory(page);
  assert.equal(await page.getByLabel('给整理线的消息').innerText(), '');
  await openMemory(page, '新的长期整理会话');
  assert.equal(await page.getByLabel('给整理线的消息').innerText(), '新会话自己的草稿');
  await openSettings(page);
  await settings.getByRole('option', { name: '记忆整理（当前）', exact: true }).waitFor({ state: 'attached' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '记忆整理会话', exact: true }).click();
  await page.getByRole('navigation', { name: '记忆整理会话列表' }).getByLabel('新整理会话名称').fill('独立整理讨论');
  await page.getByRole('navigation', { name: '记忆整理会话列表' }).getByRole('button', { name: '新建会话', exact: true }).click();
  await page.getByText('想怎样整理这些记忆？', { exact: true }).waitFor();
  await openSettings(page);
  await settings.getByRole('option', { name: '记忆整理（当前）', exact: true }).waitFor({ state: 'attached' });
  await settings.getByRole('option', { name: '独立整理讨论', exact: true }).waitFor({ state: 'attached' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '聊天会话', exact: true }).click();
  await navigation.getByRole('button', { name: '聊天', exact: true }).click();
  await page.getByLabel('给德谬歌的消息').waitFor();
  await page.getByLabel('给德谬歌的消息').fill('停一下，这是一段需要停止的回复。');
  await page.getByRole('button', { name: /发送/ }).click();
  await page.getByRole('button', { name: '停止', exact: true }).click({ timeout: 10000 });
  await page.getByText('这次回复已停止。', { exact: true }).waitFor();
  await page.setViewportSize({ width: 430, height: 900 });
  await openMemory(page);
  await page.getByLabel('给整理线的消息').waitFor();
  await page.screenshot({ path: join(folder, 'mobile.png'), fullPage: true });
  await openSettings(page);
  const mobileModal = await settings.boundingBox();
  assert.ok(mobileModal.x >= 0 && mobileModal.x + mobileModal.width <= 430);
  await settings.getByLabel('整理任务会话', { exact: true }).waitFor();
  await page.screenshot({ path: join(folder, 'mobile-settings.png'), fullPage: true });
  await settings.getByRole('button', { name: '关闭德谬歌设置', exact: true }).click();
  assert.deepEqual(errors, [], 'browser must not report uncaught errors');
  assert.deepEqual(legacyRequests, [], 'frontend must not use the removed polling HTTP API');
  assert.ok(followFrames > 0, 'session updates must use the native Gateway WebSocket stream');
  await writeFile(join(folder, 'result.json'), JSON.stringify({ passed: true, anonymous: anonymous.status, ...unauthorized, dedicatedSettingsButton: true, memorySessionPicker: true, readOnlySoulAndNarrativePaths: true, nativeSettingsModal: true, mobileSettingsModal: true, createSessionWithoutAssignment: true, unassignedSessionDialogue: true, perSessionMemoryDrafts: true, navigationIndependentOfAssignment: true, assignmentRequiresExplicitSubmit: true, settingsPreserveCurrentConversation: true, nativeSettingsFontSize: true, verticallyStackedCircularButtons: true, workerSelectionSurvivesRestart: true, workerConversationsSeparate: true, nativeKeyboardSendAndNewline: true, nativeUndo: true, failedSendRestoresDraft: true, nativeComposer: true, nativeLexicalEditor: true, floatingTopRightNavigation: true, nativeWebSocketFollow: true, nativeReconnectWithoutReload: true, draftsSurviveReconnect: true, draftsSeparatedByConversation: true, permissionControlAbsent: true, legacyRequests: 0, dailySessionNavigation: true, historicalReadOnly: true, memoryChatWorked: true, memoryChatRestored: true, restartRestored: true, stopWorked: true, browserErrors: errors, nativeListExcludesCompanion: true, nativeSearchExcludesCompanion: true, realModelCalls: 0 }, null, 2));
  console.log(`Browser acceptance passed. Artifacts: ${folder}`);
} catch (error) {
  const failedPage = browser?.contexts()[0]?.pages()[0];
  await failedPage?.screenshot({ path: join(folder, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(join(folder, 'failure.json'), JSON.stringify({ error: error.message, browserErrors: errors }, null, 2));
  console.error(`${error.message}\nAcceptance artifacts: ${folder}`); process.exitCode = 1;
} finally { await browser?.close(); await stop(); await writeFile(join(folder, 'host-last.log'), output); }
