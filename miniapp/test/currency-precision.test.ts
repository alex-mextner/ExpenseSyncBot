/** Server-rendered widgets preserve native travel amounts and retain legacy compact display. */
import { describe, expect, test } from 'bun:test';
import { type ComponentType, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatCard } from '../src/widgets/StatCard';
import { Ticker } from '../src/widgets/Ticker';

function renderedText(markup: string): string {
  let text = '';
  new HTMLRewriter()
    .onDocument({
      text(chunk) {
        text += chunk.text;
      },
    })
    .transform(markup);
  return text;
}

const widgets: Array<[string, ComponentType<{ value: number; currency?: string }>]> = [
  ['StatCard', StatCard],
  ['Ticker', Ticker],
];

for (const [name, Widget] of widgets) {
  describe(name, () => {
    test.each([
      { value: 0.001, text: '0,001 OMR' },
      { value: 1.234, text: '1,234 OMR' },
    ])('renders $value OMR without losing baisa', ({ value, text }) => {
      const markup = renderToStaticMarkup(createElement(Widget, { value, currency: 'OMR' }));
      expect(renderedText(markup)).toBe(text);
    });

    test.each(
      ['GEL', 'THB', 'MYR', 'KHR', 'TRY'].flatMap((currency) => [
        { currency, value: 0.01, text: `0,01 ${currency}` },
        { currency, value: 12.5, text: `12,5 ${currency}` },
      ]),
    )('renders $value $currency without rounding away hundredths', ({ currency, value, text }) => {
      const markup = renderToStaticMarkup(createElement(Widget, { value, currency }));
      expect(renderedText(markup)).toBe(text);
    });

    test('retains the compact display for other currencies', () => {
      const markup = renderToStaticMarkup(createElement(Widget, { value: 1.234, currency: 'EUR' }));
      expect(renderedText(markup)).toBe('1 EUR');
    });
  });
}

test.each([
  { value: 1_200_000, text: '1.2 млн OMR' },
  { value: 1_200_000_000, text: '1.2 млрд OMR' },
])('StatCard retains large-value abbreviations for $value', ({ value, text }) => {
  const markup = renderToStaticMarkup(createElement(StatCard, { value, currency: 'OMR' }));
  expect(renderedText(markup)).toBe(text);
});
