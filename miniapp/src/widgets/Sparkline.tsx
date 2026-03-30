// Sparkline: minimal trend line, no axes
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts';

interface Props {
  series: Array<{ date: string; value: number }>;
  label?: string;
  currency?: string;
}

export function Sparkline({ series, label, currency }: Props) {
  return (
    <div style={{ padding: '8px 12px' }}>
      {label && <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>{label}</div>}
      <div style={{ height: 60 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series}>
            <Line type="monotone" dataKey="value" stroke="#2196F3" strokeWidth={2} dot={false} />
            <Tooltip
              formatter={(v: number) => [
                `${v.toLocaleString('ru-RU')}${currency ? ` ${currency}` : ''}`,
                '',
              ]}
              labelFormatter={(l: string) => l}
              contentStyle={{ fontSize: 12 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
