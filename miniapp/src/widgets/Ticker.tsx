// Ticker: compact number with optional mini sparkline
import { LineChart, Line, ResponsiveContainer } from 'recharts';

interface Props {
  value: number;
  label?: string;
  currency?: string;
  series?: Array<{ date: string; value: number }>;
}

export function Ticker({ value, label, currency, series }: Props) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px' }}>
      <div>
        {label && <div style={{ fontSize: 10, opacity: 0.5 }}>{label}</div>}
        <div style={{ fontSize: 18, fontWeight: 600 }}>
          {value.toLocaleString('ru-RU', { maximumFractionDigits: 0 })}
          {currency ? ` ${currency}` : ''}
        </div>
      </div>
      {series && series.length > 1 && (
        <div style={{ width: 60, height: 28 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series}>
              <Line type="monotone" dataKey="value" stroke="#888" strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
