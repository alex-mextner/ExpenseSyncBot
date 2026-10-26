/**
 * Weighted least-squares line fit shared by LOESS and robust (IRLS) regression.
 * Split out of pattern.ts/trend.ts so both use one accumulation order: the sums must be
 * accumulated in the same sequence to keep forecasts bit-for-bit stable.
 */

export interface WeightedSums {
  sw: number;
  swx: number;
  swy: number;
  swx2: number;
  swxy: number;
}

export interface LineFit {
  slope: number;
  intercept: number;
}

/** Accumulates Σw, Σwx, Σwy, Σwx², Σwxy over parallel arrays (missing entries count as 0). */
export function accumulateWeightedSums(xs: number[], ys: number[], ws: number[]): WeightedSums {
  let sw = 0;
  let swx = 0;
  let swy = 0;
  let swx2 = 0;
  let swxy = 0;

  for (let k = 0; k < xs.length; k++) {
    const x = xs[k] ?? 0;
    const y = ys[k] ?? 0;
    const w = ws[k] ?? 0;
    sw += w;
    swx += w * x;
    swy += w * y;
    swx2 += w * x * x;
    swxy += w * x * y;
  }

  return { sw, swx, swy, swx2, swxy };
}

/** Normal-equation determinant below which the weighted fit is treated as degenerate. */
const DEGENERATE_DENOMINATOR = 1e-12;

/** Solves the weighted line fit; returns null when the system is (near-)singular. */
export function solveWeightedLine({ sw, swx, swy, swx2, swxy }: WeightedSums): LineFit | null {
  const denom = sw * swx2 - swx * swx;
  if (Math.abs(denom) < DEGENERATE_DENOMINATOR) return null;

  const slope = (sw * swxy - swx * swy) / denom;
  const intercept = (swy - slope * swx) / sw;
  return { slope, intercept };
}
