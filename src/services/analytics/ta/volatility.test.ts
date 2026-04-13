import { describe, expect, test } from 'bun:test';
import {
  atr,
  bollingerBands,
  donchianChannels,
  ewmaVariance,
  historicalVolatility,
  keltnerChannels,
  maEnvelopes,
} from './volatility';

const data = [100, 120, 110, 130, 150, 140, 160];
const stableData = [100, 100, 100, 100, 100, 100];

describe('bollingerBands', () => {
  test('upper > middle > lower', () => {
    const bb = bollingerBands(data, 6);
    expect(bb.upper).toBeGreaterThan(bb.middle);
    expect(bb.middle).toBeGreaterThan(bb.lower);
  });

  test('percentB is between 0 and 1 for typical data', () => {
    const bb = bollingerBands(data, 6);
    // Last value 160 is above mean, so %B > 0.5
    expect(bb.percentB).toBeGreaterThan(0.5);
  });

  test('bandwidth is 0 for constant data', () => {
    const bb = bollingerBands(stableData, 3);
    expect(bb.bandwidth).toBe(0);
    expect(bb.percentB).toBe(0.5);
  });

  test('insufficient data returns last value with default bands', () => {
    const bb = bollingerBands([100], 6);
    expect(bb.middle).toBe(100);
    expect(bb.bandwidth).toBe(0);
  });
});

describe('atr', () => {
  test('returns positive value for varying data', () => {
    expect(atr(data, 6)).toBeGreaterThan(0);
  });

  test('returns 0 for single value', () => {
    expect(atr([100], 6)).toBe(0);
  });

  test('returns 0 for constant data', () => {
    expect(atr(stableData, 3)).toBe(0);
  });
});

describe('keltnerChannels', () => {
  test('upper > middle > lower', () => {
    const kc = keltnerChannels(data, 6, 6);
    expect(kc.upper).toBeGreaterThan(kc.middle);
    expect(kc.middle).toBeGreaterThan(kc.lower);
  });

  test('middle equals EMA value', () => {
    const kc = keltnerChannels(stableData, 3, 3);
    // Stable data → EMA converges to 100
    expect(kc.middle).toBeCloseTo(100, 0);
  });
});

describe('donchianChannels', () => {
  test('upper = max, lower = min of window', () => {
    const dc = donchianChannels(data, 6);
    expect(dc.upper).toBe(160);
    expect(dc.lower).toBe(110);
  });

  test('breakout high detected when latest = max', () => {
    // data ends with 160 which is the max of last 6 values
    const dc = donchianChannels(data, 6);
    expect(dc.isBreakoutHigh).toBe(true);
  });

  test('empty data returns zeros', () => {
    const dc = donchianChannels([], 6);
    expect(dc.upper).toBe(0);
    expect(dc.lower).toBe(0);
  });
});

describe('historicalVolatility', () => {
  test('positive for varying data', () => {
    expect(historicalVolatility(data, 6)).toBeGreaterThan(0);
  });

  test('zero for single value', () => {
    expect(historicalVolatility([100], 6)).toBe(0);
  });
});

describe('maEnvelopes', () => {
  test('bands are symmetric around middle', () => {
    const env = maEnvelopes(data, 6, 0.2);
    const upperDist = env.upper - env.middle;
    const lowerDist = env.middle - env.lower;
    expect(upperDist).toBeCloseTo(lowerDist, 5);
  });

  test('20% envelope creates correct width', () => {
    const env = maEnvelopes(stableData, 3, 0.2);
    expect(env.upper).toBeCloseTo(120, 0);
    expect(env.lower).toBeCloseTo(80, 0);
  });
});

describe('ewmaVariance', () => {
  test('positive for varying data', () => {
    expect(ewmaVariance(data)).toBeGreaterThan(0);
  });

  test('zero for single value', () => {
    expect(ewmaVariance([100])).toBe(0);
  });
});
