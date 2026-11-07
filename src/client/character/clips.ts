import { Quaternion } from 'three';
import { bakedClips } from './clips.generated.js';

/**
 * A baked character clip. Frames are sampled at fixed 30 fps from a VMD whose MMD bezier
 * interpolation was evaluated during baking, so the runtime only interpolates between adjacent
 * frames and never has to own an AnimationMixer for imported motion.
 *
 * Semantics (kept explicit on purpose):
 * - rotations are absolute local rotations of the listed bone;
 * - `mask` is the complete set of bones the clip controls; every other bone keeps the authored
 *   baseline;
 * - `reference` names what frame 0 means. MPL scripts start from the MMD rest pose, which is not
 *   this model's calibrated idle stance, so the clip must always be blended over the baseline
 *   rather than written absolutely;
 * - `duration` is in seconds, matching the clip's own timeline.
 */
export interface CharacterClipFrame {
  t: number;
  rotations: Record<string, [number, number, number, number]>;
  positions?: Record<string, [number, number, number]>;
}

export interface CharacterClip {
  name: string;
  fps: number;
  duration: number;
  mask: string[];
  reference: string;
  interpolation: string;
  frames: CharacterClipFrame[];
  source: Record<string, string>;
}

export const characterClips = bakedClips as unknown as Record<string, CharacterClip>;

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
