/**
 * get_technical_analysis report text.
 * Shared mocks live in tool-executor.test-support.ts.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  ctx,
  executeTool,
  mockGetFinancialSnapshot,
  mockGroups,
} from './tool-executor.test-support';

// ── get_technical_analysis ──────────────────────────────────────────

describe('get_technical_analysis', () => {
  beforeEach(() => {
    mockGetFinancialSnapshot.mockReset();
  });

  test('returns graceful message when no TA data', async () => {
    mockGetFinancialSnapshot.mockReturnValue({ technicalAnalysis: null });
    const result = await executeTool('get_technical_analysis', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Недостаточно данных');
  });

  test('returns analysis for all categories', async () => {
    mockGetFinancialSnapshot.mockReturnValue({
      technicalAnalysis: {
        categories: [
          {
            category: 'Food',
            monthsOfData: 6,
            currentMonthSpent: 280,
            trend: {
              direction: 'rising',
              confidence: 0.8,
              macd: { crossover: 'none', histogram: 0 },
              rsi: { value: 55, signal: 'neutral' },
              hurst: { value: 0.65, type: 'trending' },
              changePoints: [],
              pivotPoints: {
                support1: 200,
                support2: 150,
                pivot: 300,
                resistance1: 400,
                resistance2: 450,
              },
            },
            forecasts: {
              ensemble: 350,
              holt: { forecast: 340, trend: 10 },
              theta: { forecast: 360 },
              quantiles: { p50: 320, p75: 380, p90: 420, p95: 450 },
              croston: null,
            },
            volatility: {
              bollingerBands: {
                upper: 420,
                middle: 300,
                lower: 180,
                bandwidth: 0.8,
                percentB: 0.7,
              },
              atr: 45,
              historicalVol: 0.15,
              donchian: {
                upper: 450,
                lower: 180,
                middle: 315,
                isBreakoutHigh: false,
                isBreakoutLow: false,
              },
            },
            anomaly: {
              isAnomaly: false,
              anomalyCount: 0,
              zScore: { zScore: 1.2, direction: 'above' },
            },
          },
        ],
        correlations: [],
      },
    });

    const result = await executeTool('get_technical_analysis', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Food');
    expect(result.output).toContain('растут');
    expect(result.output).toContain('Прогноз по истории');
    expect(result.output).toContain('Текущий месяц: потрачено 280');
    expect(result.output).toContain('Темп текущего месяца');
    expect(result.output).toContain('Обычный коридор');
    expect(result.output).not.toContain('MACD');
    expect(result.output).not.toContain('RSI');
    expect(result.output).not.toContain('Bollinger');
  });

  test('filters by category name', async () => {
    mockGetFinancialSnapshot.mockReturnValue({
      technicalAnalysis: {
        categories: [
          {
            category: 'Food',
            monthsOfData: 6,
            currentMonthSpent: 180,
            trend: {
              direction: 'stable',
              confidence: 0.5,
              macd: { crossover: 'none', histogram: 0 },
              rsi: { value: 50, signal: 'neutral' },
              hurst: { value: 0.5, type: 'random_walk' },
              changePoints: [],
              pivotPoints: {
                support1: 100,
                support2: 80,
                pivot: 150,
                resistance1: 200,
                resistance2: 220,
              },
            },
            forecasts: {
              ensemble: 200,
              holt: { forecast: 200, trend: 0 },
              theta: { forecast: 200 },
              quantiles: { p50: 190, p75: 220, p90: 250, p95: 270 },
              croston: null,
            },
            volatility: {
              bollingerBands: {
                upper: 250,
                middle: 200,
                lower: 150,
                bandwidth: 0.5,
                percentB: 0.5,
              },
              atr: 20,
              historicalVol: 0.1,
              donchian: {
                upper: 250,
                lower: 150,
                middle: 200,
                isBreakoutHigh: false,
                isBreakoutLow: false,
              },
            },
            anomaly: {
              isAnomaly: false,
              anomalyCount: 0,
              zScore: { zScore: 0.5, direction: 'above' },
            },
          },
          {
            category: 'Transport',
            monthsOfData: 4,
            currentMonthSpent: 50,
            trend: {
              direction: 'falling',
              confidence: 0.7,
              macd: { crossover: 'bearish', histogram: -5 },
              rsi: { value: 30, signal: 'oversold' },
              hurst: { value: 0.4, type: 'mean_reverting' },
              changePoints: [],
              pivotPoints: {
                support1: 50,
                support2: 30,
                pivot: 80,
                resistance1: 110,
                resistance2: 130,
              },
            },
            forecasts: {
              ensemble: 70,
              holt: { forecast: 65, trend: -5 },
              theta: { forecast: 75 },
              quantiles: { p50: 65, p75: 85, p90: 100, p95: 110 },
              croston: null,
            },
            volatility: {
              bollingerBands: { upper: 110, middle: 80, lower: 50, bandwidth: 0.75, percentB: 0.3 },
              atr: 15,
              historicalVol: 0.2,
              donchian: {
                upper: 120,
                lower: 50,
                middle: 85,
                isBreakoutHigh: false,
                isBreakoutLow: false,
              },
            },
            anomaly: {
              isAnomaly: false,
              anomalyCount: 0,
              zScore: { zScore: -0.8, direction: 'below' },
            },
          },
        ],
        correlations: [],
      },
    });

    const result = await executeTool('get_technical_analysis', { category: 'Transport' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Transport');
    expect(result.output).not.toContain('Food');
    expect(result.output).toContain('снижаются');
  });

  test('returns message for unknown category', async () => {
    mockGetFinancialSnapshot.mockReturnValue({
      technicalAnalysis: {
        categories: [
          {
            category: 'Food',
            monthsOfData: 3,
            currentMonthSpent: 150,
            trend: {
              direction: 'stable',
              confidence: 0.5,
              macd: { crossover: 'none', histogram: 0 },
              rsi: { value: 50, signal: 'neutral' },
              hurst: { value: 0.5, type: 'random_walk' },
              changePoints: [],
              pivotPoints: {
                support1: 100,
                support2: 80,
                pivot: 150,
                resistance1: 200,
                resistance2: 220,
              },
            },
            forecasts: {
              ensemble: 200,
              holt: { forecast: 200, trend: 0 },
              theta: { forecast: 200 },
              quantiles: { p50: 190, p75: 220, p90: 250, p95: 270 },
              croston: null,
            },
            volatility: {
              bollingerBands: {
                upper: 250,
                middle: 200,
                lower: 150,
                bandwidth: 0.5,
                percentB: 0.5,
              },
              atr: 20,
              historicalVol: 0.1,
              donchian: {
                upper: 250,
                lower: 150,
                middle: 200,
                isBreakoutHigh: false,
                isBreakoutLow: false,
              },
            },
            anomaly: {
              isAnomaly: false,
              anomalyCount: 0,
              zScore: { zScore: 0.5, direction: 'above' },
            },
          },
        ],
        correlations: [],
      },
    });

    const result = await executeTool('get_technical_analysis', { category: 'Unknown' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Нет данных для категории');
    expect(result.output).toContain('Food');
  });

  test('shows anomaly warning in user-friendly language', async () => {
    mockGetFinancialSnapshot.mockReturnValue({
      technicalAnalysis: {
        categories: [
          {
            category: 'Shopping',
            monthsOfData: 8,
            currentMonthSpent: 520,
            trend: {
              direction: 'rising',
              confidence: 0.9,
              macd: { crossover: 'bullish', histogram: 15 },
              rsi: { value: 75, signal: 'overbought' },
              hurst: { value: 0.7, type: 'trending' },
              changePoints: [{ index: 3 }],
              pivotPoints: {
                support1: 300,
                support2: 250,
                pivot: 400,
                resistance1: 500,
                resistance2: 550,
              },
            },
            forecasts: {
              ensemble: 480,
              holt: { forecast: 500, trend: 25 },
              theta: { forecast: 460 },
              quantiles: { p50: 450, p75: 510, p90: 560, p95: 600 },
              croston: null,
            },
            volatility: {
              bollingerBands: {
                upper: 550,
                middle: 400,
                lower: 250,
                bandwidth: 0.75,
                percentB: 0.85,
              },
              atr: 60,
              historicalVol: 0.18,
              donchian: {
                upper: 580,
                lower: 250,
                middle: 415,
                isBreakoutHigh: true,
                isBreakoutLow: false,
              },
            },
            anomaly: {
              isAnomaly: true,
              anomalyCount: 2,
              zScore: { zScore: 2.8, direction: 'above' },
            },
          },
        ],
        correlations: [
          {
            category1: 'Shopping',
            category2: 'Food',
            correlation: 0.82,
            strength: 'strong_positive' as const,
          },
        ],
      },
    });

    const result = await executeTool('get_technical_analysis', {}, ctx);
    expect(result.success).toBe(true);
    // User-friendly anomaly message
    expect(result.output).toContain('Необычный расход');
    // User-friendly MACD message
    expect(result.output).toContain('Расходы начали расти после периода снижения');
    // User-friendly RSI message
    expect(result.output).toContain('непривычно высокие');
    // User-friendly Hurst
    expect(result.output).toContain('стабильный');
    // Record high (Donchian)
    expect(result.output).toContain('исторического максимума');
    // Change points
    expect(result.output).toContain('резких смен');
    // Correlations
    expect(result.output).toContain('Связи между категориями');
    expect(result.output).toContain('растут вместе');
    expect(result.output).toContain('сильная');
    // No TA jargon
    expect(result.output).not.toContain('MACD');
    expect(result.output).not.toContain('RSI');
    expect(result.output).not.toContain('Hurst');
    expect(result.output).not.toContain('Donchian');
    expect(result.output).not.toContain('Bollinger');
    expect(result.output).not.toContain('откат');
  });

  test('amounts are converted from EUR to group default_currency and formatted', async () => {
    // Group uses RSD — TA snapshot carries EUR, output must be converted + formatted.
    mockGroups.findById.mockReturnValue({
      id: 1,
      telegram_group_id: 456,
      title: null,
      invite_link: null,
      google_refresh_token: 'token',
      spreadsheet_id: 'sheet',
      default_currency: 'RSD',
      enabled_currencies: ['RSD', 'EUR'],
      custom_prompt: null,
      active_topic_id: null,
      oauth_client: 'legacy' as const,
      bank_panel_summary_message_id: null,
      bank_cards_enabled: 1,
      created_at: '',
      updated_at: '',
    });

    mockGetFinancialSnapshot.mockReturnValue({
      technicalAnalysis: {
        categories: [
          {
            category: 'Food',
            monthsOfData: 6,
            currentMonthSpent: 100, // EUR
            trend: {
              direction: 'stable',
              confidence: 0.5,
              macd: { crossover: 'none', histogram: 0 },
              rsi: { value: 50, signal: 'neutral' },
              hurst: { value: 0.5, type: 'random_walk' },
              changePoints: [],
              pivotPoints: {
                support1: 50,
                support2: 40,
                pivot: 80,
                resistance1: 120,
                resistance2: 140,
              },
            },
            forecasts: {
              ensemble: 150,
              holt: { forecast: 150, trend: 5 },
              theta: { forecast: 150 },
              quantiles: { p50: 140, p75: 170, p90: 200, p95: 220 },
              croston: null,
            },
            volatility: {
              bollingerBands: {
                upper: 200,
                middle: 100,
                lower: 50,
                bandwidth: 0.5,
                percentB: 0.5,
              },
              atr: 20,
              historicalVol: 0.1,
              donchian: {
                upper: 220,
                lower: 50,
                middle: 135,
                isBreakoutHigh: false,
                isBreakoutLow: false,
              },
            },
            anomaly: {
              isAnomaly: false,
              anomalyCount: 0,
              zScore: { zScore: 0.5, direction: 'above' },
            },
          },
        ],
        correlations: [],
      },
    });

    const result = await executeTool('get_technical_analysis', {}, ctx);
    expect(result.success).toBe(true);
    // Raw EUR values (100, 150, 50, 120, 200) must NOT leak into user output as-is.
    // RSD values are hundreds of times bigger → converted output contains "RSD".
    expect(result.output).toContain('RSD');
    // The raw EUR forecast (150) followed by RSD would be a leak — proper convert
    // of 150 EUR → RSD is thousands, not 150.
    const output = result.output ?? '';
    expect(output).not.toMatch(/Прогноз по истории: ~150 /);
    expect(output).not.toMatch(/Текущий месяц: потрачено 100 /);
  });

  test('EUR group output uses EUR currency formatting', async () => {
    // Sanity: for EUR groups, output is correctly formatted in EUR (no ambiguity).
    mockGroups.findById.mockReturnValue({
      id: 1,
      telegram_group_id: 456,
      title: null,
      invite_link: null,
      google_refresh_token: 'token',
      spreadsheet_id: 'sheet',
      default_currency: 'EUR',
      enabled_currencies: ['EUR'],
      custom_prompt: null,
      active_topic_id: null,
      oauth_client: 'legacy' as const,
      bank_panel_summary_message_id: null,
      bank_cards_enabled: 1,
      created_at: '',
      updated_at: '',
    });

    mockGetFinancialSnapshot.mockReturnValue({
      technicalAnalysis: {
        categories: [
          {
            category: 'Food',
            monthsOfData: 6,
            currentMonthSpent: 100,
            trend: {
              direction: 'stable',
              confidence: 0.5,
              macd: { crossover: 'none', histogram: 0 },
              rsi: { value: 50, signal: 'neutral' },
              hurst: { value: 0.5, type: 'random_walk' },
              changePoints: [],
              pivotPoints: {
                support1: 50,
                support2: 40,
                pivot: 80,
                resistance1: 120,
                resistance2: 140,
              },
            },
            forecasts: {
              ensemble: 150,
              holt: { forecast: 150, trend: 0 },
              theta: { forecast: 150 },
              quantiles: { p50: 140, p75: 170, p90: 200, p95: 220 },
              croston: null,
            },
            volatility: {
              bollingerBands: {
                upper: 200,
                middle: 100,
                lower: 50,
                bandwidth: 0.5,
                percentB: 0.5,
              },
              atr: 20,
              historicalVol: 0.1,
              donchian: {
                upper: 220,
                lower: 50,
                middle: 135,
                isBreakoutHigh: false,
                isBreakoutLow: false,
              },
            },
            anomaly: {
              isAnomaly: false,
              anomalyCount: 0,
              zScore: { zScore: 0.5, direction: 'above' },
            },
          },
        ],
        correlations: [],
      },
    });

    const result = await executeTool('get_technical_analysis', {}, ctx);
    expect(result.success).toBe(true);
    // EUR output should include EUR currency markers
    expect(result.output).toContain('€');
  });
});
