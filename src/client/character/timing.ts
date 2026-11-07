/** Deadline pacing avoids rounding a 60 Hz display into 20/30 Hz when a frame misses by a fraction. */
export class FramePacer {
  private previous: number | undefined;
  private next = 0;
  constructor(private readonly interval = 1000 / 60) {}
  reset(): void { this.previous = undefined; this.next = 0; }
  sample(now: number): number | undefined {
    if (this.previous !== undefined && now + .5 < this.next) return undefined;
    const delta = this.previous === undefined ? 0 : Math.min(.1, Math.max(0, (now - this.previous) / 1000));
    this.previous = now;
    if (!this.next || now - this.next > this.interval * 2) this.next = now + this.interval;
    else do { this.next += this.interval; } while (this.next <= now + .5);
    return delta;
  }
}
