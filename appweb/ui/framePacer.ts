/**
 * Converts a possibly fractional steps-per-frame rate into integer VM work.
 * The remainder is retained, so 0.1 produces one step every ten frames and
 * 0.5 produces one step every two frames.
 */
export class FramePacer {
  private credit = 0;

  take(rate: number): number {
    if (!Number.isFinite(rate) || rate < 0) throw new RangeError('invalid steps-per-frame rate');
    this.credit += rate;
    const steps = Math.floor(this.credit + 1e-9);
    this.credit -= steps;
    if (Math.abs(this.credit) < 1e-9) this.credit = 0;
    return steps;
  }

  reset(): void {
    this.credit = 0;
  }
}
