/**
 * Fixed input vectors and the exact entry points pinned by characterization.test.ts.
 * Kept separate so the golden fixture can be regenerated from the same inputs.
 */
import { analyzeCategory } from './analyzer';
import { dixonTest, grubbsTest } from './anomaly';
import { croston, crostonTSB } from './forecasting';
import { kama } from './moving-averages';
import { categoryCorrelation, hurstExponent, loess, stlDecomposition } from './pattern';
import { polynomialRegression, robustRegression } from './trend';

export const SERIES: Record<string, number[]> = {
  empty: [],
  one: [5],
  two: [5, 9],
  three: [3, 1, 4],
  flat: [7, 7, 7, 7, 7, 7, 7, 7, 7, 7],
  short: [300, 320, 280, 350],
  year: [300, 320, 280, 350, 310, 290, 340, 300, 330, 280, 360, 310],
  rising: [100, 120, 135, 160, 170, 200, 215, 240, 260, 275, 300, 330, 345, 370],
  falling: [500, 470, 455, 430, 400, 380, 350, 340, 300, 280, 260, 240],
  outlier: [100, 110, 95, 105, 900, 102, 98, 107, 99, 101],
  lowOutlier: [500, 510, 495, 505, 20, 502, 498, 507, 499, 501],
  intermittent: [0, 0, 400, 0, 0, 0, 250, 0, 0, 0, 0, 120],
  intermittentLive: [0, 0, 400, 0, 0, 0, 250, 0, 120, 0, 0, 90],
  lead0: [0, 0, 0, 80, 0, 60],
  twoYears: [
    210, 190, 230, 260, 300, 340, 330, 310, 280, 250, 220, 400, 215, 195, 240, 265, 310, 345, 335,
    320, 285, 255, 230, 420, 225,
  ],
  long: Array.from({ length: 70 }, (_, i) => 100 + ((i * 37) % 23) * 5 + i),
};

/** Sample sizes 2..32 exercise every branch of the Grubbs/Dixon critical-value lookups. */
export const SIZES: number[] = Array.from({ length: 31 }, (_, i) => i + 2);

export function sizedSeries(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? 400 : 100 + ((i * 13) % 7) * 3));
}

export const CORRELATION_INPUT: Array<[string, number[]]> = [
  ['a', [1, 2, 3, 4, 5, 6]],
  ['b', [2, 4, 6, 8, 10, 12]],
  ['c', [6, 5, 4, 3, 2, 1]],
  ['d', [5, 1, 4, 2, 6, 3]],
  ['e', [1, 2]],
  ['f', [0, 9, 1, 8, 2, 7, 3]],
  ['g', [3, 4, 3, 4.5, 3.2, 4.1]],
];

export function computeGolden(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, data] of Object.entries(SERIES)) {
    out[`analyze:${name}`] = analyzeCategory('cat', data);
    out[`analyzeCur:${name}`] = analyzeCategory('cat', data, {
      currentMonthSpent: 1234,
      seasonalPeriod: 4,
    });
    out[`dixon:${name}`] = dixonTest(data);
    out[`grubbs:${name}`] = grubbsTest(data);
    out[`croston:${name}`] = croston(data);
    out[`crostonTSB:${name}`] = crostonTSB(data);
    out[`kama:${name}`] = kama(data);
    out[`kama3:${name}`] = kama(data, 3);
    out[`loess:${name}`] = loess(data);
    out[`loess.2:${name}`] = loess(data, 0.2);
    out[`hurst:${name}`] = hurstExponent(data);
    out[`stl:${name}`] = stlDecomposition(data);
    out[`stl4:${name}`] = stlDecomposition(data, 4);
    out[`poly:${name}`] = polynomialRegression(data);
    out[`poly1:${name}`] = polynomialRegression(data, 1);
    out[`poly5:${name}`] = polynomialRegression(data, 5);
    out[`robust:${name}`] = robustRegression(data);
    out[`robust3:${name}`] = robustRegression(data, 3);
  }
  for (const n of SIZES) {
    const data = sizedSeries(n);
    out[`sizedGrubbs:${n}`] = grubbsTest(data);
    out[`sizedDixon:${n}`] = dixonTest(data);
    out[`sizedDixonLow:${n}`] = dixonTest(data.map((v) => 1000 - v));
  }
  out['correlation'] = categoryCorrelation(new Map(CORRELATION_INPUT));
  out['correlationLow'] = categoryCorrelation(new Map(CORRELATION_INPUT), 0);
  return out;
}
