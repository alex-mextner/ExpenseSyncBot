// Dashboard tab: renders configurable widgets with drag-to-reorder and real-time SSE updates
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AnalyticsData } from '../api/analytics';
import { getAnalytics, getDashboard, putDashboard, subscribeDashboardEvents } from '../api/analytics';
import { BarChart } from '../widgets/BarChart';
import { KPIBand } from '../widgets/KPIBand';
import { Sparkline } from '../widgets/Sparkline';
import { StatCard } from '../widgets/StatCard';
import { Ticker } from '../widgets/Ticker';
import { WIDGET_REGISTRY, type WidgetConfig, type WidgetType } from '../widgets/registry';
import { resolveBuiltin } from '../datasources/builtin';
import { evaluateFormula, validateFormula } from '../datasources/formula';

interface Props { groupId: number; }

export function Dashboard({ groupId }: Props) {
  const [widgets, setWidgets] = useState<WidgetConfig[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCatalog, setShowCatalog] = useState(false);
  const [editWidget, setEditWidget] = useState<WidgetConfig | null>(null);
  const [error, setError] = useState<string>('');

  // Load dashboard config + analytics
  const reload = useCallback(async () => {
    try {
      const [dash, data] = await Promise.all([
        getDashboard(groupId),
        getAnalytics(groupId),
      ]);
      setWidgets(dash.widgets.slice().sort((a, b) => a.position - b.position));
      setUpdatedAt(dash.updatedAt);
      setAnalytics(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => { void reload(); }, [reload]);

  // SSE subscription
  useEffect(() => {
    const unsub = subscribeDashboardEvents(groupId, (event) => {
      if (event === 'expense_added' || event === 'poll') {
        getAnalytics(groupId).then(setAnalytics).catch(() => {});
      }
    });
    return unsub;
  }, [groupId]);

  // Save dashboard config
  const save = useCallback(async (newWidgets: WidgetConfig[]) => {
    try {
      const sorted = newWidgets.slice().sort((a, b) => a.position - b.position);
      const result = await putDashboard(groupId, sorted, updatedAt);
      setUpdatedAt(result.updatedAt);
      setWidgets(sorted);
    } catch (e) {
      if (e instanceof Error && e.message.includes('409')) {
        // Reload on conflict
        await reload();
      } else {
        setError(e instanceof Error ? e.message : 'Ошибка сохранения');
      }
    }
  }, [groupId, updatedAt, reload]);

  const handleAddWidget = useCallback((type: WidgetType) => {
    const maxPos = widgets.reduce((m, w) => Math.max(m, w.position), 0);
    const newWidget: WidgetConfig = {
      id: `w_${Date.now()}`,
      type,
      position: maxPos + 1,
      config: WIDGET_REGISTRY[type].defaultConfig,
    };
    setShowCatalog(false);
    setEditWidget(newWidget);
  }, [widgets]);

  const handleSaveWidget = useCallback(async (w: WidgetConfig) => {
    const exists = widgets.some(x => x.id === w.id);
    const newWidgets = exists
      ? widgets.map(x => x.id === w.id ? w : x)
      : [...widgets, w];
    setEditWidget(null);
    await save(newWidgets);
  }, [widgets, save]);

  const handleDeleteWidget = useCallback(async (id: string) => {
    const newWidgets = widgets.filter(w => w.id !== id);
    setEditWidget(null);
    await save(newWidgets);
  }, [widgets, save]);

  // Drag-to-reorder
  const dragRef = useRef<{ id: string; startY: number } | null>(null);

  const handleDragStart = (id: string, y: number) => {
    dragRef.current = { id, startY: y };
  };

  const handleDragEnd = useCallback(async (id: string, endY: number) => {
    if (!dragRef.current || dragRef.current.id !== id) return;
    const dy = endY - dragRef.current.startY;
    dragRef.current = null;
    if (Math.abs(dy) < 20) return;

    // Move widget up/down based on drag direction
    const idx = widgets.findIndex(w => w.id === id);
    if (idx === -1) return;
    const newWidgets = widgets.slice();
    const target = dy > 0 ? idx + 1 : idx - 1;
    if (target < 0 || target >= newWidgets.length) return;

    // Swap positions
    const tmp = newWidgets[idx].position;
    newWidgets[idx] = { ...newWidgets[idx], position: newWidgets[target].position };
    newWidgets[target] = { ...newWidgets[target], position: tmp };
    await save(newWidgets);
  }, [widgets, save]);

  if (loading) {
    return <div style={{ padding: 24, textAlign: 'center', marginTop: 80 }}>Загрузка…</div>;
  }

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ color: '#F44336', marginBottom: 12 }}>{error}</div>
        <button onClick={reload} style={btnStyle}>Повторить</button>
      </div>
    );
  }

  return (
    <div style={{ padding: '12px 8px', paddingBottom: 80 }}>
      {widgets.length === 0 && (
        <div style={{ textAlign: 'center', padding: 40, opacity: 0.5 }}>
          Нет виджетов. Нажми + чтобы добавить.
        </div>
      )}

      {widgets.map(widget => (
        <div
          key={widget.id}
          style={{ marginBottom: 8, border: '1px solid rgba(128,128,128,0.15)', borderRadius: 10, overflow: 'hidden', cursor: 'grab' }}
          onTouchStart={e => handleDragStart(widget.id, e.touches[0].clientY)}
          onTouchEnd={e => void handleDragEnd(widget.id, e.changedTouches[0].clientY)}
          onClick={() => setEditWidget(widget)}
        >
          <WidgetRenderer widget={widget} analytics={analytics} />
        </div>
      ))}

      {/* Add button */}
      <button
        onClick={() => setShowCatalog(true)}
        style={{
          position: 'fixed', bottom: 24, right: 24,
          width: 52, height: 52, borderRadius: 26,
          background: '#2196F3', color: '#fff',
          border: 'none', fontSize: 28, cursor: 'pointer',
          boxShadow: '0 4px 12px rgba(33,150,243,0.5)',
        }}
      >
        +
      </button>

      {/* Widget catalog modal */}
      {showCatalog && (
        <Modal title="Добавить виджет" onClose={() => setShowCatalog(false)}>
          {(Object.keys(WIDGET_REGISTRY) as WidgetType[]).map(type => (
            <button
              key={type}
              onClick={() => handleAddWidget(type)}
              style={{ ...btnStyle, marginBottom: 8, background: 'rgba(128,128,128,0.1)', color: 'inherit' }}
            >
              {WIDGET_REGISTRY[type].name}
            </button>
          ))}
        </Modal>
      )}

      {/* Widget editor modal */}
      {editWidget && (
        <WidgetEditor
          widget={editWidget}
          analytics={analytics}
          onSave={handleSaveWidget}
          onDelete={() => void handleDeleteWidget(editWidget.id)}
          onClose={() => setEditWidget(null)}
        />
      )}
    </div>
  );
}

// --- Widget renderer ---

function WidgetRenderer({ widget, analytics }: { widget: WidgetConfig; analytics: AnalyticsData | null }) {
  if (!analytics) return <div style={{ padding: 12, opacity: 0.5 }}>Нет данных</div>;

  const resolveValue = (expr: string): number => {
    try {
      // Try as builtin key first
      if (/^[\w.]+$/.test(expr)) {
        const resolved = resolveBuiltin(expr as Parameters<typeof resolveBuiltin>[0], analytics);
        return resolved.value;
      }
      return evaluateFormula(expr, analytics);
    } catch { return 0; }
  };

  switch (widget.type) {
    case 'StatCard': {
      const c = widget.config as { value: string; label?: string; comparison?: string };
      return <StatCard value={resolveValue(c.value)} label={c.label} currency={analytics.defaultCurrency} comparison={c.comparison ? resolveValue(c.comparison) : undefined} />;
    }
    case 'KPIBand': {
      const c = widget.config as { items: Array<{ value: string; label?: string }> };
      const items = c.items.map(it => ({ value: resolveValue(it.value), label: it.label, currency: analytics.defaultCurrency }));
      return <KPIBand items={items} />;
    }
    case 'Ticker': {
      const c = widget.config as { value: string; label?: string };
      return <Ticker value={resolveValue(c.value)} label={c.label} currency={analytics.defaultCurrency} />;
    }
    case 'Sparkline': {
      const c = widget.config as { series: string; label?: string };
      // Sparkline needs time series data — show placeholder
      return <Sparkline series={[]} label={c.label ?? c.series} currency={analytics.defaultCurrency} />;
    }
    case 'BarChart': {
      const series = Object.entries(analytics.byCategory).map(([label, value]) => ({ label, value }));
      return <BarChart series={series} label={(widget.config as { label?: string }).label} currency={analytics.defaultCurrency} />;
    }
    case 'BalanceLine': {
      return <div style={{ padding: 12, opacity: 0.5 }}>Баланс (нет исторических данных)</div>;
    }
    case 'Heatmap': {
      return <div style={{ padding: 12, opacity: 0.5 }}>Тепловая карта (нет ежедневных данных)</div>;
    }
    case 'SmallMultiples': {
      return <div style={{ padding: 12, opacity: 0.5 }}>Мини-графики (нет исторических данных)</div>;
    }
    default:
      return <div style={{ padding: 12, opacity: 0.5 }}>Неизвестный виджет</div>;
  }
}

// --- Widget editor ---

interface EditorProps {
  widget: WidgetConfig;
  analytics: AnalyticsData | null;
  onSave: (w: WidgetConfig) => void;
  onDelete: () => void;
  onClose: () => void;
}

function WidgetEditor({ widget, analytics, onSave, onDelete, onClose }: EditorProps) {
  const [value, setValue] = useState(() => {
    const c = widget.config as { value?: string; label?: string };
    return c.value ?? '';
  });
  const [label, setLabel] = useState(() => {
    const c = widget.config as { label?: string };
    return c.label ?? '';
  });
  const [formulaError, setFormulaError] = useState<string>('');

  const handleValueChange = (v: string) => {
    setValue(v);
    // Validate if it looks like a formula (has operators)
    if (/[+\-*/(]/.test(v)) {
      const err = validateFormula(v);
      setFormulaError(err ?? '');
    } else {
      setFormulaError('');
    }
  };

  const handleSave = () => {
    if (formulaError) return;
    onSave({
      ...widget,
      config: { ...widget.config, value, label },
      label,
    });
  };

  // Autocomplete hints: builtin keys
  const hints = analytics ? Object.keys(analytics.byCategory).map(c => `expenses.${c}`) : [];
  const baseHints = ['income', 'expenses', 'balance', 'savings', ...hints];
  const filtered = value.length > 0
    ? baseHints.filter(k => k.includes(value.toLowerCase()))
    : baseHints;

  return (
    <Modal title={`Виджет: ${WIDGET_REGISTRY[widget.type].name}`} onClose={onClose}>
      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, opacity: 0.6 }}>Значение / формула</label>
        <input
          value={value}
          onChange={e => handleValueChange(e.target.value)}
          placeholder="expenses или expenses + income"
          style={{ ...inputStyle, width: '100%', marginTop: 4 }}
        />
        {formulaError && <div style={{ color: '#F44336', fontSize: 12, marginTop: 4 }}>{formulaError}</div>}
        {filtered.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
            {filtered.slice(0, 8).map(hint => (
              <button
                key={hint}
                onClick={() => handleValueChange(hint)}
                style={{ padding: '3px 8px', border: '1px solid rgba(128,128,128,0.3)', borderRadius: 12, background: 'none', fontSize: 11, cursor: 'pointer' }}
              >
                {hint}
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 12, opacity: 0.6 }}>Подпись (необязательно)</label>
        <input
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="Расходы"
          style={{ ...inputStyle, width: '100%', marginTop: 4 }}
        />
      </div>
      <button onClick={handleSave} style={btnStyle} disabled={!!formulaError}>Сохранить</button>
      <button
        onClick={onDelete}
        style={{ ...btnStyle, background: 'rgba(244,67,54,0.1)', color: '#F44336', marginTop: 8 }}
      >
        Удалить
      </button>
    </Modal>
  );
}

// --- Modal component ---

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100,
      display: 'flex', alignItems: 'flex-end',
    }}>
      <div style={{
        background: 'var(--tg-theme-bg-color, #fff)', borderRadius: '16px 16px 0 0',
        padding: '16px 16px 32px', width: '100%', maxHeight: '80dvh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', opacity: 0.5 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  display: 'block', width: '100%', padding: '12px 16px',
  background: '#2196F3', color: '#fff', border: 'none', borderRadius: 10,
  fontSize: 15, fontWeight: 600, cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
  padding: '8px 12px',
  border: '1px solid rgba(128,128,128,0.3)',
  borderRadius: 8, fontSize: 14,
  background: 'transparent', color: 'inherit',
  boxSizing: 'border-box',
};
