export const MIN_SCALE = .25;
export const MAX_SCALE = 6;
export const stageSize = (scale: number) => ({ width: 320 * scale, height: 480 * scale });

/** Keep the top handle reachable; the body is allowed to extend beyond every viewport edge. */
export function constrainHandle(position: { x: number; y: number; scale: number }, viewport: { width: number; height: number }) {
  const { width, height } = stageSize(position.scale);
  const margin = 16;
  return {
    x: Math.min(viewport.width - margin - width / 2, Math.max(margin - width / 2, position.x)),
    y: Math.min(viewport.height - 24 - height, Math.max(margin - height, position.y)),
  };
}

export function upperBodyFrame(viewport: { width: number; height: number }) {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, viewport.height / 288));
  const { width, height } = stageSize(scale);
  return { scale, x: 24 - width / 4, y: viewport.height - height - Math.max(24, viewport.height * .08) };
}
