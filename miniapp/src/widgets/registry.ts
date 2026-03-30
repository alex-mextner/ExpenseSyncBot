// Widget type enum, WidgetConfig interface, and registry map
export type WidgetType =
  | 'StatCard'
  | 'KPIBand'
  | 'Ticker'
  | 'Sparkline'
  | 'BarChart'
  | 'BalanceLine'
  | 'Heatmap'
  | 'SmallMultiples';

export interface StatCardConfig {
  value: string;       // BuiltinKey or formula
  target?: string;
  comparison?: string;
  label?: string;
}

export interface KPIBandConfig {
  items: StatCardConfig[];
}

export interface TickerConfig {
  value: string;
  series?: string;
  label?: string;
}

export interface SparklineConfig {
  series: string;  // BuiltinKey for time series
  label?: string;
}

export interface BarChartConfig {
  series: string;  // BuiltinKey prefix (e.g. "expenses.*" = all categories)
  label?: string;
}

export interface BalanceLineConfig {
  balance: string;
  forecast?: string;
  label?: string;
}

export interface HeatmapConfig {
  series: string;
  label?: string;
}

export interface SmallMultiplesConfig {
  categories: string[];
  label?: string;
}

export type WidgetTypeConfig =
  | { type: 'StatCard'; config: StatCardConfig }
  | { type: 'KPIBand'; config: KPIBandConfig }
  | { type: 'Ticker'; config: TickerConfig }
  | { type: 'Sparkline'; config: SparklineConfig }
  | { type: 'BarChart'; config: BarChartConfig }
  | { type: 'BalanceLine'; config: BalanceLineConfig }
  | { type: 'Heatmap'; config: HeatmapConfig }
  | { type: 'SmallMultiples'; config: SmallMultiplesConfig };

export interface WidgetConfig {
  id: string;
  type: WidgetType;
  position: number;
  config: StatCardConfig | KPIBandConfig | TickerConfig | SparklineConfig | BarChartConfig | BalanceLineConfig | HeatmapConfig | SmallMultiplesConfig;
  label?: string;
}

/** Human-readable names and default configs per widget type */
export const WIDGET_REGISTRY: Record<WidgetType, { name: string; defaultConfig: WidgetConfig['config'] }> = {
  StatCard: {
    name: 'Число',
    defaultConfig: { value: 'expenses', label: 'Расходы' },
  },
  KPIBand: {
    name: 'Полоса KPI',
    defaultConfig: { items: [{ value: 'expenses', label: 'Расходы' }] },
  },
  Ticker: {
    name: 'Тикер',
    defaultConfig: { value: 'expenses', label: 'Расходы' },
  },
  Sparkline: {
    name: 'Тренд',
    defaultConfig: { series: 'expenses', label: 'Расходы' },
  },
  BarChart: {
    name: 'Бары',
    defaultConfig: { series: 'expenses.*', label: 'По категориям' },
  },
  BalanceLine: {
    name: 'Баланс',
    defaultConfig: { balance: 'balance', label: 'Баланс' },
  },
  Heatmap: {
    name: 'Тепловая карта',
    defaultConfig: { series: 'expenses', label: 'Интенсивность' },
  },
  SmallMultiples: {
    name: 'Мини-графики',
    defaultConfig: { categories: ['expenses.*'] },
  },
};
