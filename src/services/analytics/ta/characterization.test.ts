import { describe, expect, test } from 'bun:test';
import golden from './golden.json';
import { computeGolden } from './golden-cases';

/**
 * Bit-exact pins for the numerically sensitive TA functions. Golden values were captured from the
 * implementation before the complexity refactor; any change in floating-point operation order
 * shows up here as a mismatch.
 */
describe('TA numerical characterization', () => {
  const actual = JSON.parse(JSON.stringify(computeGolden())) as Record<string, unknown>;
  const expected = golden as Record<string, unknown>;

  test('covers the same set of cases as the golden fixture', () => {
    expect(Object.keys(actual)).toEqual(Object.keys(expected));
  });

  for (const key of Object.keys(expected)) {
    test(`matches golden output: ${key}`, () => {
      expect(actual[key]).toEqual(expected[key]);
    });
  }
});
