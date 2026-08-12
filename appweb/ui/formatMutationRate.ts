/**
 * Format the per-byte, per-epoch mutation probability as a percentage.
 *
 * The control spans 1e-6 through 1e-2. Three significant decimal digits keep
 * that range readable without exposing scientific notation to the operator.
 */
export function formatMutationRate(rate: number): string {
  if (rate === 0) return 'off';
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new RangeError(`mutation rate must be a finite probability: ${rate}`);
  }

  const percent = rate * 100;
  const magnitude = Math.floor(Math.log10(percent));
  const decimals = Math.max(0, Math.min(6, 2 - magnitude));
  const fixed = percent.toFixed(decimals);
  const value = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return `${value}%`;
}

/** Shared logarithmic mutation control: 1e-6 through 1e-2, with hard zero. */
export function mutationSliderToRate(position: number): number {
  return position <= 0 ? 0 : Math.pow(10, -6 + (position / 100) * 4);
}

export function mutationRateToSlider(rate: number): number {
  return rate <= 0 ? 0 : Math.round(((Math.log10(rate) + 6) / 4) * 100);
}
