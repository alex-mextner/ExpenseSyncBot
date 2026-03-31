// BalanceLine: balance over time with optional forecast
import {
  ComposedChart,
  Line,
  Area,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  ReferenceLine,
} from 'recharts';

interface DataPoint {
  date: string;
  balance: number;
  forecast?: number;
}

interface Props {
  data: DataPoint[];
  label?: string;
  currency?: string;
}

export function BalanceLine({ data, label, currency }: Props) {
  return (
    <div style={{ padding: '8px 12px' }}>
      {label && <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>{label}</div>}
      <div style={{ height: 80 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
            <XAxis dataKey="date" hide />
            <YAxis hide />
            <ReferenceLine y={0} stroke="#ccc" strokeDasharray="3 3" />
            <Area
              type="monotone"
              dataKey="balance"
              fill="#2196F310"
              stroke="#2196F3"
              strokeWidth={2}
              dot={false}
            />
            {data.some(d => d.forecast != null) && (
              <Line
                type="monotone"
                dataKey="forecast"
                stroke="#FF9800"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={false}
              />
            )}
            <Tooltip
              formatter={(v: number) => [
                `${v.toLocaleString('ru-RU')}${currency ? ` ${currency}` : ''}`,
                '',
              ]}
              contentStyle={{ fontSize: 12 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
