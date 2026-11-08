// Local authoring bridge. No network calls, provider keys, or runtime dependencies.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const [command, input, output] = process.argv.slice(2);
if (!['prepare', 'compile'].includes(command) || !input || !output) {
  throw Error('Usage: node scripts/authoring/popo-draft.mjs prepare <description.txt> <.local/output-dir> | compile <response.mpl-or-json> <.local/output-dir>');
}
const directory = resolve(output), local = resolve('.local');
const subpath = relative(local, directory);
if (!subpath || subpath.startsWith('..') || isAbsolute(subpath)) throw Error('Draft outputs must be inside .local/');
mkdirSync(directory, { recursive: true });
const popo = resolve('.local/tools/PoPo');
const mpl = resolve('.local/tools/MMD-MPL');
const hash = value => createHash('sha256').update(value).digest('hex');
function run(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.error || result.status !== 0) throw Error(result.error?.message ?? result.stderr ?? 'Tool failed');
  return result.stdout.trim();
}
const provenance = {
  popo: { repository: 'https://github.com/AmyangXYZ/PoPo', commit: run('git', ['rev-parse', 'HEAD'], popo), license: 'GPL-3.0' },
  mpl: { repository: 'https://github.com/AmyangXYZ/MMD-MPL', commit: run('git', ['rev-parse', 'HEAD'], mpl), license: 'GPL-3.0' },
};
if (command === 'prepare') {
  // Read upstream prompt locally, do not copy GPL implementation into product sources.
  const source = readFileSync(join(popo, 'src/app/api/pose-generate/route.ts'), 'utf8');
  const match = source.match(/const systemPrompt = `([\s\S]*?)`\s*\r?\n\s*const userPrompt/);
  if (!match) throw Error('PoPo prompt layout changed; review upstream before using.');
  const prompt = match[1].replace(/\\`/g, '`');
  const request = {
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: readFileSync(resolve(input), 'utf8') + '\nAuthoring scope: only head/neck/torso/shoulders/arms/wrists/fingers. No legs, physics, translations, props, or contact guarantees. Start at explicit reset, finish at a target pose. This is an uncalibrated pose draft, not a production animation. Output MPL only.' },
    ],
  };
  writeFileSync(join(directory, 'request.json'), JSON.stringify(request, null, 2));
  writeFileSync(join(directory, 'request-source.json'), JSON.stringify({ ...provenance, upstreamPromptSha256: hash(prompt) }, null, 2));
  console.log('Prepared local request.json; no model API was called. Use an explicitly configured authoring provider or author MPL directly.');
} else {
  const response = readFileSync(resolve(input), 'utf8');
  const code = (response.trim().startsWith('{') ? JSON.parse(response).mpl : response);
  if (typeof code !== 'string' || !code.trim()) throw Error('Expected MPL text or PoPo {mpl: string} response.');
  const clean = code.trim().replace(/^```(?:mpl)?\s*\r?\n/i, '').replace(/\r?\n```$/, '').trim();
  const sourcePath = join(directory, 'draft.mpl'), vmdPath = join(directory, 'draft.vmd');
  writeFileSync(sourcePath, clean);
  run(join(mpl, 'cmd/mpl.exe'), ['-c', sourcePath, '-o', vmdPath]);
  const { Parser } = createRequire(import.meta.url)('mmd-parser');
  const data = readFileSync(vmdPath);
  const parsed = new Parser().parseVmd(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), true);
  if (!parsed.motions.length) throw Error('Compiler returned no bone keys.');
  const allowed = /^(上半身[12]?|下半身|腰|首|頭|[左右](肩|腕|ひじ|手首|(親指|人指|中指|薬指|小指)[０１２３]))$/;
  const first = new Map(), last = new Map();
  for (const key of parsed.motions) {
    if (!allowed.test(key.boneName)) throw Error('Out-of-scope draft channel: ' + key.boneName);
    if (![...key.rotation, ...key.position].every(Number.isFinite) || key.position.some(x => Math.abs(x) > 1e-6)) throw Error('Invalid or translated draft key.');
    if (Math.abs(Math.hypot(...key.rotation) - 1) > .001) throw Error('Invalid rotation quaternion.');
    if (!first.has(key.boneName) || key.frameNum < first.get(key.boneName).frameNum) first.set(key.boneName, key);
    if (!last.has(key.boneName) || key.frameNum > last.get(key.boneName).frameNum) last.set(key.boneName, key);
  }
  const rotations = map => Object.fromEntries([...map].map(([name, key]) => [name, key.rotation]));
  writeFileSync(join(directory, 'pose-draft.json'), JSON.stringify({
    schema: 'liveseed-pose-draft/v1', status: 'uncalibrated',
    reference: 'MPL source first keys; NOT LiveSeed idle or a calibrated additive reference',
    mask: [...last.keys()], sourceReferenceRotations: rotations(first), targetRotations: rotations(last),
    source: { ...provenance, mplSha256: hash(clean), vmdSha256: hash(data), generator: 'external MPL input; no claim of a PoPo model call' },
  }, null, 2));
  console.log(`Compiled ${last.size} channels to local draft.vmd and pose-draft.json. Calibration and visual acceptance required before runtime registration.`);
}
