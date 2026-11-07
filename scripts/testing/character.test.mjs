import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { CharacterAssets } from '../../dist/adapters/harness/character-assets.js';
import { descriptors } from '../../dist/adapters/harness/remote-contract.js';
import { NativePose } from '../../dist/client/character/pose.js';
import { sampleClip, characterClips } from '../../dist/client/character/clips.js';
import { AnimationMixer, Bone, BufferGeometry, MeshBasicMaterial, Skeleton, SkinnedMesh, Quaternion, Vector3 } from 'three';
import { FramePacer } from '../../dist/client/character/timing.js';
import { constrainHandle, stageSize, upperBodyFrame } from '../../dist/client/character/layout.js';

test('character resources are a native authenticated route with an opaque, contained asset catalogue', async t => {
  await mkdir('.local', { recursive: true });
  const folder = await mkdtemp(resolve('.local/character-assets-'));
  const root = join(folder, 'models'); await mkdir(join(root, '角色'), { recursive: true });
  await writeFile(join(root, '角色/角色.pmx'), Buffer.from('PMX synthetic resource fixture'));
  await writeFile(join(root, '角色/颜.png'), Buffer.from('synthetic image fixture'));
  await writeFile(join(root, '角色/使用规则.txt'), 'not a resource');
  await writeFile(join(folder, 'outside.png'), 'outside');
  const elsewhere = join(folder, 'elsewhere'); await mkdir(elsewhere);
  await writeFile(join(elsewhere, 'external.pmx'), 'must not be indexed');
  try { await symlink(elsewhere, join(root, 'external'), 'junction'); }
  catch (error) { t.diagnostic(`Junction creation unavailable: ${error.code}`); }
  const assets = new CharacterAssets(root);
  const catalog = await assets.catalog();
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0].resources.length, 2);
  assert.ok(!JSON.stringify(catalog).includes(folder), 'filesystem absolute paths stay on the host');
  const resource = catalog.models[0].resources.find(item => item.name === '颜.png');
  const response = await assets.fetch(new Request('http://localhost'+resource.url));
  assert.equal(response.status, 200); assert.equal(await response.text(), 'synthetic image fixture');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  const head = await assets.fetch(new Request('http://localhost'+resource.url, { method: 'HEAD' }));
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  for (const value of ['../../outside.png', '使用规则.txt', '%2e%2e%2foutside.png', 'a'.repeat(64)]) {
    assert.equal((await assets.fetch(new Request('http://localhost/api/liveseed/character-resource?id='+encodeURIComponent(value)))).status, 404);
  }
  const registrations = [];
  assets.install({ connection: { fetch: { register(route) { registrations.push(route); } } } });
  const registration = registrations[0];
  assert.equal(registration.path, '/api/liveseed/character-resource');
  assert.deepEqual(registration.methods, ['GET', 'HEAD']);
  assert.ok(registrations.every(route => route.path.startsWith('/api/liveseed/')));
  assert.ok(descriptors.find(item => item.method === 'character'));
  assert.deepEqual(await new CharacterAssets(join(folder, 'absent')).catalog(), { models: [] });
  const invalid = new CharacterAssets(join(root, '角色/角色.pmx'));
  await assert.rejects(invalid.catalog());
  assert.equal((await invalid.fetch(new Request('http://localhost/api/liveseed/character-resource'))).status, 503);
});

test('display layout permits upper-body cropping while preserving a reachable top handle', () => {
  for (const viewport of [{ width: 1360, height: 920 }, { width: 412, height: 860 }]) {
    const framing = upperBodyFrame(viewport);
    const position = constrainHandle(framing, viewport), size = stageSize(framing.scale);
    const top = viewport.height - position.y - size.height;
    const center = viewport.width - position.x - size.width / 2;
    assert.ok(position.y < 0, 'body is deliberately allowed below the viewport');
    assert.ok(size.height > viewport.height, 'zoom is not capped to the viewport height');
    assert.ok(top >= 0 && top + 24 <= viewport.height);
    assert.ok(center >= 16 && center <= viewport.width - 16);
  }
});

test('frame pacing maintains about 60 fps on ordinary and high-refresh displays', () => {
  for (const refresh of [60, 75, 120, 144]) {
    const clock = new FramePacer(); let rendered = 0;
    for (let i = 0; i < refresh * 6; i++) if (clock.sample(i * 1000 / refresh) !== undefined) rendered++;
    assert.ok(rendered >= 355 && rendered <= 361, `${refresh} Hz produced ${rendered} frames in 6 seconds`);
    clock.reset(); assert.equal(clock.sample(1000000), 0, 'returning from a hidden page never catches up old elapsed time');
  }
});

test('arm targets retain limb lengths and lift the hand using measured directions in a rotated torso frame', () => {
  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial());
  mesh.rotation.y = .7;
  const torso = new Bone(); torso.name = '上半身2'; torso.position.y = 10; mesh.add(torso);
  const nodes = [torso]; const hands = [];
  for (const [side, sign] of [['右', -1], ['左', 1]]) {
    let parent = torso;
    for (const [suffix, x, y, z] of [['腕', sign, 0, 0], ['腕捩', sign*.8, -.6, 0], ['ひじ', sign*.8, -.6, 0], ['手捩', sign*.8, -.6, 0], ['手首', sign*.8, -.6, 0]]) {
      const bone = new Bone(); bone.name = side+suffix; bone.position.set(x,y,z); parent.add(bone); nodes.push(bone); parent=bone;
    }
    hands.push(parent);
  }
  mesh.bind(new Skeleton(nodes));
  const pose = new NativePose(mesh,20); const mixer = new AnimationMixer(mesh); mixer.clipAction(pose.base).play();
  const step = dt => { mixer.update(dt); pose.apply(dt); mesh.updateMatrixWorld(true); };
  const point = name => nodes.find(bone => bone.name===name).getWorldPosition(new Vector3());
  step(0);
  const localHand = point('右手首').sub(point('右腕')).applyQuaternion(torso.getWorldQuaternion(new Quaternion()).invert());
  assert.ok(localHand.x < -1.5 && localHand.z > .5, 'resting wrist stays outside and in front of the coat');
  const upperLength = point('右ひじ').distanceTo(point('右腕')), forearmLength = point('右手首').distanceTo(point('右ひじ'));
  pose.gesture('wave'); for(let i=0;i<90;i++) step(1/60);
  assert.ok(Math.abs(point('右ひじ').distanceTo(point('右腕'))-upperLength)<1e-6);
  assert.ok(Math.abs(point('右手首').distanceTo(point('右ひじ'))-forearmLength)<1e-6);
  const raised = point('右手首').sub(point('右ひじ')).applyQuaternion(torso.getWorldQuaternion(new Quaternion()).invert());
  assert.ok(raised.y > 1, 'greeting raises the forearm rather than twisting about an arbitrary local X axis');
});

test('baked clip keeps its mask, samples continuously and clamps at its duration', () => {
  const clip = characterClips['wave-small'];
  assert.ok(clip, 'wave-small clip is baked into the client bundle');
  assert.deepEqual([...clip.mask].sort(), ['右ひじ', '右手首', '右肩', '右腕'].sort());
  assert.equal(clip.fps, 30);
  assert.equal(clip.duration, 2.2);
  assert.equal(clip.frames.length, Math.round(clip.duration * clip.fps) + 1);
  for (const frame of clip.frames) {
    for (const bone of Object.keys(frame.rotations)) assert.ok(clip.mask.includes(bone), 'frames only write masked bones');
  }
  const start = sampleClip(clip, 0);
  assert.equal(start.size, 4);
  let previous = start, max = 0;
  for (let frame = 1; frame <= Math.round(clip.duration * clip.fps); frame++) {
    const next = sampleClip(clip, frame / 30);
    for (const [bone, value] of next) max = Math.max(max, previous.get(bone).angleTo(value));
    previous = next;
  }
  assert.ok(max > .001, 'clip actually moves');
  assert.ok(max < .2, 'adjacent 30 fps samples stay continuous, max step=' + max.toFixed(4));
  assert.equal(sampleClip(clip, 99).size, 4, 'sampling past the end clamps to the last frame');
});

test('clip layer blends over the authored baseline and releases back without drift', () => {
  const names = ['センター', '上半身', '上半身1', '上半身2', '首', '頭', '両目', '右肩', '右腕', '右ひじ', '右手首'];
  const bones = names.map(name => { const bone = new Bone(); bone.name = name; return bone; });
  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial());
  bones.forEach(bone => mesh.add(bone)); mesh.bind(new Skeleton(bones));
  const pose = new NativePose(mesh, 20); const mixer = new AnimationMixer(mesh); mixer.clipAction(pose.base).play();
  const step = dt => { mixer.update(dt); pose.apply(dt); };
  const arm = bones[names.indexOf('右腕')], elbow = bones[names.indexOf('右ひじ')];
  step(1 / 60);
  const baseArm = arm.quaternion.clone();
  pose.playClip(characterClips['wave-small']);
  for (let i = 0; i < 40; i++) step(1 / 60);
  assert.ok(arm.quaternion.angleTo(baseArm) > .05, 'clip layer moves the arm');
  assert.ok(elbow.quaternion.angleTo(new Quaternion()) > .01, 'clip layer also drives the elbow');
  pose.stopClip();
  for (let i = 0; i < 120; i++) step(1 / 60);
  assert.ok(!pose.clipActive(), 'clip layer releases after fading out');
  assert.ok(arm.quaternion.angleTo(baseArm) < 1e-4, 'release returns to the authored baseline');
});

test('native pose input returns to baseline without drift and leaves dependent bones to MMD', () => {
  const names = ['センター', '上半身', '上半身1', '上半身2', '首', '頭', '両目', '左足ＩＫ', '右足D'];
  const bones = names.map(name => { const bone = new Bone(); bone.name = name; return bone; });
  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial());
  bones.forEach(bone => mesh.add(bone)); mesh.bind(new Skeleton(bones));
  mesh.morphTargetDictionary = { 'まばたき': 0, '照れ': 1 }; mesh.morphTargetInfluences = [0, 0];
  const pose = new NativePose(mesh, 20); const mixer = new AnimationMixer(mesh); mixer.clipAction(pose.base).play();
  const step = () => { mixer.update(1/60); pose.apply(1/60); };
  pose.morph('照れ', .5); step(); assert.equal(mesh.morphTargetInfluences[1], .5);
  pose.clearMorphs(); step(); assert.equal(mesh.morphTargetInfluences[1], 0);
  const head = bones[names.indexOf('頭')], dependent = bones[names.indexOf('右足D')];
  for (let repeat=0; repeat<4; repeat++) {
    pose.gesture('nod'); for(let i=0;i<30;i++) step();
    assert.ok(head.quaternion.angleTo(new Quaternion()) > .001);
    pose.gesture('stop'); for(let i=0;i<90;i++) step();
    assert.ok(head.quaternion.angleTo(new Quaternion()) < 1e-6);
    assert.ok(dependent.quaternion.angleTo(new Quaternion()) < 1e-6);
  }
  pose.gesture('leg'); for(let i=0;i<60;i++) step();
  assert.ok(bones[names.indexOf('左足ＩＫ')].position.y > .01);
  for(let i=0;i<180;i++) step();
  assert.ok(Math.abs(bones[names.indexOf('左足ＩＫ')].position.y)<1e-6);
  assert.ok(bones.every(bone => [...bone.position.toArray(),...bone.quaternion.toArray()].every(Number.isFinite)));
});
