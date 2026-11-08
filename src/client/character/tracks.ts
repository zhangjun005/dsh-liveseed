import type { CharacterClip } from './clips.js';

export type MotionTrack = 'hands' | 'head' | 'body';
export const motionTracks: MotionTrack[] = ['hands', 'head', 'body'];
export function boneTrack(name: string): MotionTrack {
  if (/^[左右](肩|腕|ひじ|手首|親指|人指|中指|薬指|小指)/.test(name)) return 'hands';
  if (['首', '頭', '両目'].includes(name)) return 'head';
  return 'body';
}
/** Ignore constant reference keys: a hand clip's empty head channels must not claim the head. */
export function trackMask(clip: CharacterClip, track: MotionTrack): string[] {
  return clip.mask.filter(name => {
    if (boneTrack(name) !== track) return false;
    const reference = clip.frames[0]?.rotations[name];
    const position = clip.frames[0]?.positions?.[name] ?? [0, 0, 0];
    return clip.frames.some(frame => {
      const q = frame.rotations[name];
      return (reference && q && Math.abs(q.reduce((sum, x, i) => sum + x * reference[i]!, 0)) / (Math.hypot(...q) * Math.hypot(...reference)) < 1 - 1e-10)
        || frame.positions?.[name]?.some((x, i) => Math.abs(x - position[i]!) > 1e-8);
    });
  });
}
