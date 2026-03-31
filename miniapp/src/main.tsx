// App entry point: resolves groupId from multiple sources, renders Scanner or Dashboard
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { apiRequest } from './api/client';
import { Dashboard } from './tabs/Dashboard';
import { Scanner } from './tabs/Scanner';

/** Parse startapp param format: "tab_groupId", "_groupId", or just "tab" */
function parseStartParam(startParam: string): { tab: string | null; groupId: string | null } {
  const match = startParam.match(/^([a-z]*)_(-?\d+)$/);
  if (match) {
    return { tab: match[1] || null, groupId: match[2] };
  }
  return { tab: startParam, groupId: null };
}

/** Resolve groupId from URL params, startapp param, or initDataUnsafe.chat */
function resolveGroupId(): { groupId: string | null; tab: string } {
  const params = new URLSearchParams(window.location.search);
  const urlGroupId = params.get('groupId');
  let tab = params.get('tab') ?? 'scanner';

  if (urlGroupId) {
    return { groupId: urlGroupId, tab };
  }

  const startParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param;
  if (startParam) {
    const parsed = parseStartParam(startParam);
    tab = parsed.tab || tab;
    if (parsed.groupId) {
      return { groupId: parsed.groupId, tab };
    }
  }

  const chatId = window.Telegram?.WebApp?.initDataUnsafe?.chat?.id;
  if (chatId) {
    return { groupId: String(chatId), tab };
  }

  return { groupId: null, tab };
}

/** Build t.me/c/ link from a Telegram group ID */
function buildGroupLink(telegramGroupId: number): string {
  const idStr = telegramGroupId.toString();
  const chatId = idStr.startsWith('-100') ? idStr.slice(4) : idStr.slice(1);
  return `https://t.me/c/${chatId}`;
}

interface UserGroup {
  telegramGroupId: number;
}

interface UserGroupsResponse {
  groups: UserGroup[];
  botUsername: string;
}

/** Fallback screen when no groupId is available — shows links to user's groups */
function NoGroupScreen() {
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [botUsername, setBotUsername] = useState('ExpenseSyncBot');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    apiRequest<UserGroupsResponse>('/api/user/groups')
      .then((data) => {
        setGroups(data.groups);
        setBotUsername(data.botUsername);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '80vh',
      padding: '24px',
      textAlign: 'center',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      color: 'var(--tg-theme-text-color, #000)',
      backgroundColor: 'var(--tg-theme-bg-color, #fff)',
    }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>
        {'\uD83D\uDCB8'}
      </div>
      <h2 style={{
        fontSize: 20,
        fontWeight: 600,
        margin: '0 0 8px',
        color: 'var(--tg-theme-text-color, #000)',
      }}>
        ExpenseSync
      </h2>
      <p style={{
        fontSize: 15,
        color: 'var(--tg-theme-hint-color, #999)',
        margin: '0 0 24px',
        lineHeight: 1.4,
      }}>
        Открой Mini App из группы с ботом,<br />
        чтобы начать учёт расходов
      </p>

      {loading && (
        <p style={{ fontSize: 14, color: 'var(--tg-theme-hint-color, #999)' }}>
          Загрузка...
        </p>
      )}

      {!loading && !error && groups.length > 0 && (
        <div style={{ width: '100%', maxWidth: 280 }}>
          {groups.map((g) => (
            <a
              key={g.telegramGroupId}
              href={buildGroupLink(g.telegramGroupId)}
              style={{
                display: 'block',
                padding: '12px 20px',
                marginBottom: 8,
                borderRadius: 12,
                backgroundColor: 'var(--tg-theme-button-color, #3390ec)',
                color: 'var(--tg-theme-button-text-color, #fff)',
                textDecoration: 'none',
                fontSize: 15,
                fontWeight: 500,
              }}
            >
              Перейти в группу
            </a>
          ))}
        </div>
      )}

      {!loading && (error || groups.length === 0) && (
        <p style={{
          fontSize: 14,
          color: 'var(--tg-theme-hint-color, #999)',
          lineHeight: 1.4,
        }}>
          Добавь <b>@{botUsername}</b> в группу<br />
          и набери /connect
        </p>
      )}
    </div>
  );
}

const { groupId, tab } = resolveGroupId();

function App() {
  if (!groupId) {
    return <NoGroupScreen />;
  }

  return tab === 'dashboard'
    ? <Dashboard groupId={Number(groupId)} />
    : <Scanner groupId={Number(groupId)} />;
}

const root = createRoot(document.getElementById('root')!);
root.render(<React.StrictMode><App /></React.StrictMode>);
