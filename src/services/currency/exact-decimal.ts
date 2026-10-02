import Big from 'big.js';

const Rounded = Big();
Rounded.DP = 40;
Rounded.RM = 1;

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

/** Exact bounded rational intermediates; decimal rounding happens only at display time. */
export class ExactDecimal {
  private readonly n: bigint;
  private readonly d: bigint;

  constructor(value: string | number | bigint, denominator = 1n) {
    let n: bigint;
    let d = denominator;
    if (typeof value === 'bigint') n = value;
    else {
      const raw = String(value);
      const exponent = raw.match(/[eE]([+-]?\d+)$/);
      if (raw.length > 800 || (exponent && Math.abs(Number(exponent[1])) > 324))
        throw new Error('PRECISION_LIMIT');
      const fixed = new Big(raw).toFixed();
      const decimals = fixed.split('.')[1]?.length ?? 0;
      n = BigInt(fixed.replace('.', ''));
      d = 10n ** BigInt(decimals);
    }
    if (d === 0n) throw new Error('DIVISION_BY_ZERO');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const divisor = gcd(n, d);
    n /= divisor;
    d /= divisor;
    if (n.toString().length > 4096 || d.toString().length > 4096)
      throw new Error('PRECISION_LIMIT');
    this.n = n;
    this.d = d;
  }
  private other(value: ExactDecimal | string | number): ExactDecimal {
    return value instanceof ExactDecimal ? value : new ExactDecimal(value);
  }

  plus(value: ExactDecimal | string | number): ExactDecimal {
    const b = this.other(value);
    return new ExactDecimal(this.n * b.d + b.n * this.d, this.d * b.d);
  }

  minus(value: ExactDecimal | string | number): ExactDecimal {
    const b = this.other(value);
    return new ExactDecimal(this.n * b.d - b.n * this.d, this.d * b.d);
  }

  times(value: ExactDecimal | string | number): ExactDecimal {
    const b = this.other(value);
    return new ExactDecimal(this.n * b.n, this.d * b.d);
  }

  div(value: ExactDecimal | string | number): ExactDecimal {
    const b = this.other(value);
    return new ExactDecimal(this.n * b.d, this.d * b.n);
  }

  eq(value: ExactDecimal | string | number): boolean {
    const b = this.other(value);
    return this.n * b.d === b.n * this.d;
  }

  toFixed(): string {
    const result = new Rounded(this.n.toString()).div(this.d.toString());
    if (this.n !== 0n && result.eq(0)) throw new Error('PRECISION_LIMIT');
    return result.toFixed();
  }
}
