import { Quaternion, Vector3 } from 'three';
import { bakedClips } from './clips.generated.js';
import { behindClips } from './behind.generated.js';
import { reactionClips } from './reactions.generated.js';
import { contactClips } from './contact.generated.js';

/**
 * A baked character clip. Frames are sampled at fixed 30 fps from a VMD whose MMD bezier
 * interpolation was evaluated during baking, so the runtime only interpolates between adjacent
 * frames and never has to own an AnimationMixer for imported motion.
 *
 * Semantics (kept explicit on purpose):
 * - rotations are absolute local rotations of the listed bone;
 * - `mask` is the complete set of bones the clip controls; every other bone keeps the authored
 *   baseline. Playback applies baseline * inverse(reference) * sample, with the
 *   local delta weighted from identity; it never interpolates toward source rest;
 * - `reference` names what frame 0 means. MPL scripts start from the MMD rest pose, which is not
 *   this model's calibrated idle stance, so the clip must always be blended over the baseline
 *   rather than written absolutely;
 * - `duration` is in seconds, matching the clip's own timeline.
 */
export interface CharacterClipFrame {
  t: number;
  rotations: Record<string, [number, number, number, number]>;
  /** Local displacement samples, relative to the clip's first sample. Never world coordinates. */
  positions?: Record<string, [number, number, number]>;
}

export interface CharacterClip {
  name: string;
  fps: number;
  duration: number;
  holdAt?: number;
  releaseFrom?: number;
  mask: string[];
  reference: string;
  interpolation: string;
  frames: CharacterClipFrame[];
  source: Record<string, string>;
}

export const characterClips = { ...bakedClips, ...behindClips, ...reactionClips, ...contactClips } as unknown as Record<string, CharacterClip>;

export function sampleClipPositions(clip: CharacterClip, time: number): Map<string, Vector3> {
  const raw = Math.min(Math.max(0,time),clip.duration)*clip.fps;
  const low = Math.min(clip.frames.length-1,Math.floor(raw)), high = Math.min(clip.frames.length-1,low+1);
  const values = new Map<string, Vector3>();
  for(const name of clip.mask) {
    const from=clip.frames[low]?.positions?.[name]; if(!from) continue;
    const to=clip.frames[high]?.positions?.[name] ?? from;
    values.set(name,new Vector3(...from).lerp(new Vector3(...to),high>low?raw-low:0));
  }
  return values;
}

export function sampleClip(clip: CharacterClip, time: number): Map<string, Quaternion> {
  const at = Math.min(Math.max(0, time), clip.duration);
  const raw = at * clip.fps;
  const low = Math.min(clip.frames.length - 1, Math.floor(raw));
  const high = Math.min(clip.frames.length - 1, low + 1);
  const ratio = high > low ? raw - low : 0;
  const sampled = new Map<string, Quaternion>();
  for (const bone of clip.mask) {
    const from = clip.frames[low]?.rotations[bone];
    if (!from) continue;
    const to = clip.frames[high]?.rotations[bone] ?? from;
    const rotation = new Quaternion(...from).normalize();
    if (ratio > 0) rotation.slerp(new Quaternion(...to).normalize(), ratio);
    sampled.set(bone, rotation);
  }
  return sampled;
}
