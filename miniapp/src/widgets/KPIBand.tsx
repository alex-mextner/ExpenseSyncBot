// KPIBand: horizontal row of StatCards
import { StatCard } from './StatCard';

interface KPIItem {
  value: number;
  label?: string;
  currency?: string;
  comparison?: number;
}

interface Props {
  items: KPIItem[];
}

export function KPIBand({ items }: Props) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {items.map((item, i) => (
        <StatCard key={i} {...item} />
      ))}
    </div>
  );
}
