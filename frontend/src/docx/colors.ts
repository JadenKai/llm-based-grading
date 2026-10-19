/** Score (0..1) → one of 11 buckets, 0 = red … 5 = yellow … 10 = green. */
export const bucket = (score: number) => Math.round(Math.min(1, Math.max(0, score)) * 10);

/**
 * Hue for a bucket: red (25°) → yellow (95°) → green (145°) in OKLCH, so lightness stays
 * constant across the scale and the document text stays readable under the (multiply-blended)
 * highlight.
 */
export function bucketHue(b: number): number {
  return b <= 5 ? 25 + b * 14 : 95 + (b - 5) * 10;
}

export const scoreColor = (b: number) => `oklch(0.91 0.09 ${bucketHue(b)})`;
export const scoreInk = (b: number) => `oklch(0.5 0.16 ${bucketHue(b)})`;
export const scoreColorFor = (score: number) => scoreColor(bucket(score));
export const scoreInkFor = (score: number) => scoreInk(bucket(score));

export const scoreLabel = (score: number) => {
  const s = score * 100;
  if (s >= 85) return "Strongly supports thesis";
  if (s >= 65) return "Supports thesis";
  if (s >= 45) return "Neutral / partly relevant";
  if (s >= 20) return "Weak";
  return "Detracts from thesis";
};
