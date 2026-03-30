// BarChart: horizontal bars by category, no grid
import {
  BarChart as ReBarChart,
  Bar,
  XAxis,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';

interface Props {
  series: Array<{ label: string; value: number }>;
  label?: string;
  currency?: string;
}

const COLORS = [
  '#2196F3',
  '#4CAF50',
  '#FF9800',
  '#9C27B0',
  '#F44336',
  '#00BCD4',
  '#8BC34A',
  '#FF5722',
];

export function BarChart({ series, label, currency }: Props) {
  const sorted = [...series].sort((a, b) => b.value - a.value);
  return (
    <div style={{ padding: '8px 12px' }}>
      {label && <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>{label}</div>}
      <div style={{ height: Math.max(80, sorted.length * 28) }}>
        <ResponsiveContainer width="100%" height="100%">
          <ReBarChart
            data={sorted}
            layout="vertical"
            margin={{ left: 0, right: 8, top: 0, bottom: 0 }}
          >
            <XAxis type="number" hide />
            <Bar dataKey="value" radius={[0, 4, 4, 0]} label={{ position: 'right', fontSize: 10 }}>
              {sorted.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Bar>
            <Tooltip
              formatter={(v: number) => [
                `${v.toLocaleString('ru-RU')}${currency ? ` ${currency}` : ''}`,
                '',
              ]}
            />
          </ReBarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
