// StatCard: large number with optional delta and comparison
interface Props {
  value: number;
  label?: string;
  currency?: string;
  target?: number;
  comparison?: number;
}

export function StatCard({ value, label, currency, comparison }: Props) {
  const delta = comparison != null ? value - comparison : null;
  const pct = comparison && comparison !== 0 ? ((value - comparison) / Math.abs(comparison)) * 100 : null;

  return (
    <div style={{ padding: '12px 16px', minWidth: 120 }}>
      {label && <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>{label}</div>}
      <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: -1 }}>
        {formatNum(value, currency)}
        {currency ? ` ${currency}` : ''}
      </div>
      {delta != null && (
        <div style={{ fontSize: 12, marginTop: 2, color: delta >= 0 ? '#4CAF50' : '#F44336' }}>
          {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toLocaleString('ru-RU')}
          {pct != null ? ` (${pct.toFixed(1)}%)` : ''}
        </div>
      )}
    </div>
  );
}

function formatNum(n: number, currency?: string): string {
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + ' млрд';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + ' млн';
  return n.toLocaleString('ru-RU', { maximumFractionDigits: currency === 'OMR' ? 3 : ['GEL', 'THB', 'MYR', 'KHR', 'TRY'].includes(currency ?? '') ? 2 : 0 });
}
