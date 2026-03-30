// Heatmap: GitHub-style calendar heatmap for daily spending intensity
interface Props {
  series: Array<{ date: string; value: number }>;
  label?: string;
}

const WEEKS = 12; // show last 12 weeks

export function Heatmap({ series, label }: Props) {
  const byDate: Record<string, number> = {};
  for (const p of series) {
    byDate[p.date] = p.value;
  }
  const max = Math.max(...series.map(p => p.value), 1);

  // Build 12-week grid ending today
  const today = new Date();
  const cells: Array<{ date: string; value: number }> = [];
  for (let w = WEEKS - 1; w >= 0; w--) {
    for (let d = 0; d < 7; d++) {
      const dt = new Date(today);
      dt.setDate(today.getDate() - w * 7 - (6 - d));
      const key = dt.toISOString().slice(0, 10);
      cells.push({ date: key, value: byDate[key] ?? 0 });
    }
  }

  return (
    <div style={{ padding: '8px 12px' }}>
      {label && <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 6 }}>{label}</div>}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${WEEKS}, 12px)`,
          gridTemplateRows: 'repeat(7, 12px)',
          gap: 2,
        }}
      >
        {cells.map((cell, i) => (
          <div
            key={i}
            title={`${cell.date}: ${cell.value.toLocaleString('ru-RU')}`}
            style={{
              width: 12,
              height: 12,
              borderRadius: 2,
              backgroundColor:
                cell.value === 0
                  ? 'rgba(128,128,128,0.1)'
                  : `rgba(33,150,243,${0.15 + 0.85 * (cell.value / max)})`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
