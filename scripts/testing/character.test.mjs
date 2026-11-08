import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { CharacterAssets } from '../../dist/adapters/harness/character-assets.js';
import { descriptors } from '../../dist/adapters/harness/remote-contract.js';
import { NativePose } from '../../dist/client/character/pose.js';
import { sampleClip, sampleClipPositions, characterClips } from '../../dist/client/character/clips.js';
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

test('clip reference is neutral on a nonidentity baseline and nod remains independent', () => {
  const arm = new Bone(); arm.name = '右腕';
  arm.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), .65);
  const head = new Bone(); head.name = '頭';
  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial());
  mesh.add(arm, head); mesh.bind(new Skeleton([arm, head]));
  const pose = new NativePose(mesh, 20), baseline = arm.quaternion.clone();
  const reference = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), .4);
  const makeClip = delta => ({ name: 'test', fps: 30, duration: 2, mask: ['右腕'], reference: 'clip-first-frame', interpolation: 'sampled', source: {},
    frames: Array.from({length: 61}, (_, i) => ({t: i/30, rotations: {'右腕': reference.clone().multiply(i ? delta : new Quaternion()).toArray()}})) });
  pose.playClip(makeClip(new Quaternion()));
  for (let i=0;i<30;i++) pose.apply(1/60);
  assert.ok(arm.quaternion.angleTo(baseline)<1e-6, 'source rest must not replace calibrated baseline at full weight');
  const delta = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), .25);
  pose.playClip(makeClip(delta)); pose.gesture('nod');
  for (let i=0;i<40;i++) pose.apply(1/60);
  assert.ok(arm.quaternion.angleTo(baseline.clone().multiply(delta))<1e-6, 'local delta order is baseline * inverse(reference) * sample');
  assert.ok(head.quaternion.angleTo(new Quaternion())>.01, 'head nod coexists with the arm clip');
  pose.stopClip();
  let previous = arm.quaternion.clone();
  for (let i=0;i<60;i++) {
    pose.apply(1/60);
    assert.ok(previous.angleTo(arm.quaternion)<.04, 'stop fades continuously');
    previous.copy(arm.quaternion);
  }
  assert.ok(arm.quaternion.angleTo(baseline)<1e-6, 'stop returns to the same nonidentity baseline');
});

test('behind-look has a bounded enter, hold and exit and can stop back to baseline', () => {
  const clip = characterClips['hands-behind-look'];
  assert.equal(clip.frames.length, 136);
  const held=sampleClip(clip,2), reference=sampleClip(clip,0);
  const torsoAngle=['上半身','上半身1','上半身2'].reduce((total,name)=>total+held.get(name).angleTo(reference.get(name)),0);
  assert.ok(torsoAngle>.34 && torsoAngle<.42, 'visible forward lean is distributed across the torso');
  const headDelta=reference.get('頭').clone().invert().multiply(held.get('頭'));
  assert.ok(Math.abs(headDelta.z)>.06, 'held pose includes head tilt, not only counter-pitch');
  assert.ok(!clip.mask.some(n=>/袖|捩|足|肩C|肩\+/.test(n)), 'only primary upper-body inputs');
  for (const time of [0, .4, 1.7, 2.5, 3.8, 4.5]) {
    for (const [name, q] of sampleClip(clip,time)) {
      assert.ok(q.toArray().every(Number.isFinite));
      if(time===4.5) assert.ok(q.angleTo(sampleClip(clip,0).get(name))<1e-6,'exit matches entry reference');
    }
  }
  const bones=clip.mask.map(name=>{const b=new Bone();b.name=name;return b;});
  const mesh=new SkinnedMesh(new BufferGeometry(),new MeshBasicMaterial());
  bones.forEach(b=>mesh.add(b));mesh.bind(new Skeleton(bones));
  const pose=new NativePose(mesh,20);
  const controlMesh=new SkinnedMesh(new BufferGeometry(),new MeshBasicMaterial());
  const controlBones=clip.mask.map(name=>{const b=new Bone();b.name=name;controlMesh.add(b);return b;});
  controlMesh.bind(new Skeleton(controlBones));
  const controlPose=new NativePose(controlMesh,20);
  const step=()=>{pose.apply(1/60);controlPose.apply(1/60);};
  pose.apply(0);controlPose.apply(0);
  for(const stopAt of [.3,1.8,3.6]) {
    pose.playClip(clip);
    for(let t=0;t<stopAt;t+=1/60)step();
    const torso=bones.find(b=>b.name==='上半身');
    assert.ok(torso.quaternion.toArray().every(Number.isFinite));
    pose.stopClip();for(let i=0;i<120;i++)step();
    assert.ok(!pose.clipActive());
    bones.forEach((b,i)=>assert.ok(b.quaternion.angleTo(controlBones[i].quaternion)<1e-6,'stopping returns to the current animated baseline'));
  }
});

test('reaction candidates enter and return continuously, preserve unrelated channels and stop cleanly', () => {
  for(const id of ['behind-curious','side-glance','soft-open','gentle-nod']) {
    const clip=characterClips[id];
    assert.equal(clip.frames.length,Math.round(clip.duration*clip.fps)+1);
    assert.ok(!clip.mask.some(n=>/袖|捩|足|肩C|肩\+/.test(n)));
    const start=sampleClip(clip,0),end=sampleClip(clip,clip.duration);
    for(const [name,q] of start)assert.ok(q.angleTo(end.get(name))<1e-6,id+' closes its reference pose');
    let previous=start,maxStep=0;
    for(let i=1;i<clip.frames.length;i++){
      const next=sampleClip(clip,i/30);
      for(const [name,q] of next){assert.ok(q.toArray().every(Number.isFinite));maxStep=Math.max(maxStep,q.angleTo(previous.get(name)));}
      previous=next;
    }
    assert.ok(maxStep>.0001 && maxStep<.2,id+' has a moving, bounded trajectory');
    const make=()=>{
      const mesh=new SkinnedMesh(new BufferGeometry(),new MeshBasicMaterial());
      const bones=[...clip.mask,'右足D'].map(name=>{const b=new Bone();b.name=name;mesh.add(b);return b;});
      mesh.bind(new Skeleton(bones));return {pose:new NativePose(mesh,20),bones};
    };
    const actor=make(),control=make();
    actor.pose.playClip(clip);
    for(let i=0;i<50;i++){actor.pose.apply(1/60);control.pose.apply(1/60);}
    actor.pose.stopClip();
    for(let i=0;i<60;i++){actor.pose.apply(1/60);control.pose.apply(1/60);}
    assert.ok(!actor.pose.clipActive());
    actor.bones.forEach((b,i)=>assert.ok(b.quaternion.angleTo(control.bones[i].quaternion)<1e-6,id+' releases to live baseline'));
  }
});

test('contact, response and foot clips stay bounded and displacement tracks release without drift', () => {
  for(const id of ['soft-shake','thoughtful-look','listening-lean','hands-front','hand-on-chest','chin-rest','touch-hair','weight-shift','leg-sway']) {
    const clip=characterClips[id];
    assert.equal(clip.frames.length,Math.round(clip.duration*30)+1);
    const start=sampleClip(clip,0),end=sampleClip(clip,clip.duration);
    for(const [n,q] of end)assert.ok(q.angleTo(start.get(n))<1e-6,id+' closes its rotation');
    let previous=start;
    for(let i=1;i<clip.frames.length;i++){
      const next=sampleClip(clip,i/30);
      for(const [n,q] of next){assert.ok(q.toArray().every(Number.isFinite));assert.ok(previous.get(n).angleTo(q)<.25,id+' bounded adjacent rotations');}
      for(const p of sampleClipPositions(clip,i/30).values())assert.ok(p.toArray().every(Number.isFinite)&&p.length()<1,'small relative translation only');
      previous=next;
    }
    for(const p of sampleClipPositions(clip,clip.duration).values())assert.ok(p.length()<1e-6,'translations close');
    const names=[...new Set([...clip.mask,'右足D'])];
    const create=()=>{const m=new SkinnedMesh(new BufferGeometry(),new MeshBasicMaterial());const b=names.map(name=>{const bone=new Bone();bone.name=name;m.add(bone);return bone;});m.bind(new Skeleton(b));return {b,pose:new NativePose(m,20)};};
    const a=create(),control=create();a.pose.playClip(clip);
    for(let i=0;i<90;i++){a.pose.apply(1/60);control.pose.apply(1/60);}
    if(id==='leg-sway')assert.ok(a.b[names.indexOf('左足ＩＫ')].position.y>.01,'swing targets lift');
    a.pose.stopClip();for(let i=0;i<120;i++){a.pose.apply(1/60);control.pose.apply(1/60);}
    a.b.forEach((b,i)=>{assert.ok(b.position.distanceTo(control.b[i].position)<1e-6);assert.ok(b.quaternion.angleTo(control.b[i].quaternion)<1e-6);});
  }
});

test('back pose holds until explicitly released and has no exit jump', () => {
  const clip=characterClips['behind-rest'];
  const mesh=new SkinnedMesh(new BufferGeometry(),new MeshBasicMaterial());
  const bones=clip.mask.map(name=>{const b=new Bone();b.name=name;mesh.add(b);return b;});mesh.bind(new Skeleton(bones));
  const pose=new NativePose(mesh,20);pose.playClip(clip);
  for(let i=0;i<900;i++)pose.apply(1/60);
  assert.ok(pose.clipActive(),'persists beyond normal clip duration');
  const arm=bones.find(b=>b.name==='右腕'),before=arm.quaternion.clone();
  pose.stopClip();pose.apply(1/60);
  assert.ok(before.angleTo(arm.quaternion)<.02,'release follows exit from held pose');
  for(let i=0;i<120;i++)pose.apply(1/60);
  assert.ok(!pose.clipActive());
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


test('three motion tracks compose, stop independently and preserve a held hand pose', () => {
  const names=[...new Set(['behind-rest','soft-shake','tiptoe-rock'].flatMap(id=>characterClips[id].mask))];
  const create=()=>{const mesh=new SkinnedMesh(new BufferGeometry(),new MeshBasicMaterial());const bones=names.map(n=>{const b=new Bone();b.name=n;mesh.add(b);return b;});mesh.bind(new Skeleton(bones));return {pose:new NativePose(mesh,20),bones};};
  const actor=create(),hand=create(),head=create(),body=create();
  actor.pose.playClip(characterClips['behind-rest'],'hands');hand.pose.playClip(characterClips['behind-rest'],'hands');
  actor.pose.playClip(characterClips['soft-shake'],'head');head.pose.playClip(characterClips['soft-shake'],'head');
  actor.pose.playClip(characterClips['tiptoe-rock'],'body');body.pose.playClip(characterClips['tiptoe-rock'],'body');
  for(let i=0;i<90;i++)for(const x of [actor,hand,head,body])x.pose.apply(1/60);
  for(const [bone,control] of [['右腕',hand],['頭',head],['センター',body],['左足ＩＫ',body]]){
    const i=names.indexOf(bone);assert.ok(actor.bones[i].quaternion.angleTo(control.bones[i].quaternion)<1e-6,bone+' matches independent track');assert.ok(actor.bones[i].position.distanceTo(control.bones[i].position)<1e-6);
  }
  actor.pose.stopClip('body');for(let i=0;i<60;i++)actor.pose.apply(1/60);
  assert.ok(actor.pose.clipActive('hands'));assert.ok(!actor.pose.clipActive('body'));
  actor.pose.stopClip();for(let i=0;i<150;i++)actor.pose.apply(1/60);assert.ok(!actor.pose.clipActive());
});

test('same-track interruption crossfades continuously and does not cancel other tracks', () => {
  const names=['右腕','右ひじ','右手首','左腕','左ひじ','左手首','頭','首'];
  const mesh=new SkinnedMesh(new BufferGeometry(),new MeshBasicMaterial());const bones=names.map(n=>{const b=new Bone();b.name=n;mesh.add(b);return b;});mesh.bind(new Skeleton(bones));const pose=new NativePose(mesh,20);
  pose.playClip(characterClips['behind-rest'],'hands');pose.playClip(characterClips['soft-shake'],'head');for(let i=0;i<90;i++)pose.apply(1/60);
  let previous=bones.map(b=>b.quaternion.clone());pose.playClip(characterClips['hands-front'],'hands');
  for(let i=0;i<60;i++){pose.apply(1/60);bones.forEach((b,j)=>assert.ok(previous[j].angleTo(b.quaternion)<.24,'bounded switch '+b.name));previous=bones.map(b=>b.quaternion.clone());}
  assert.ok(pose.clipActive('head'),'head survives hand replacement');
});

test('tiptoe-rock controls only body and IK targets, has anchored exits and no head or hand claims', () => {
  const clip=characterClips['tiptoe-rock'];assert.ok(clip.mask.includes('右足ＩＫ')&&clip.mask.includes('左つま先ＩＫ'));
  assert.ok(!clip.mask.some(n=>/手|腕|首|頭|袖|足D/.test(n)));
  const start=sampleClip(clip,0),end=sampleClip(clip,clip.duration);
  for(const [name,q]of end)assert.ok(q.angleTo(start.get(name))<1e-6);
  for(const p of sampleClipPositions(clip,clip.duration).values())assert.ok(p.length()<1e-6);
  const raised=sampleClipPositions(clip,2);assert.ok(raised.get('センター').y>.05);assert.ok(raised.get('左足ＩＫ').y>0);
});
