// SmallMultiples: grid of sparklines, one per category
import { Sparkline } from './Sparkline';

interface CategorySeries {
  category: string;
  series: Array<{ date: string; value: number }>;
  currency?: string;
}

interface Props {
  categories: CategorySeries[];
}

export function SmallMultiples({ categories }: Props) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
        gap: 8,
      }}
    >
      {categories.map(cat => (
        <div
          key={cat.category}
          style={{ border: '1px solid rgba(128,128,128,0.15)', borderRadius: 8 }}
        >
          <Sparkline series={cat.series} label={cat.category} currency={cat.currency} />
        </div>
      ))}
    </div>
  );
}
