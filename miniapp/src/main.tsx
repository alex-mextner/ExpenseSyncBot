// App entry point: reads ?tab= and ?groupId= query params, renders Scanner or Dashboard
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Dashboard } from './tabs/Dashboard';
import { Scanner } from './tabs/Scanner';

const params = new URLSearchParams(window.location.search);
const tab = params.get('tab') ?? 'scanner';
const groupId = params.get('groupId');

function App() {
  if (!groupId) {
    return (
      <div style={{ padding: 24, textAlign: 'center', marginTop: 80 }}>
        <p>Открой эту кнопку из группы с ботом</p>
      </div>
    );
  }

  return tab === 'dashboard'
    ? <Dashboard groupId={Number(groupId)} />
    : <Scanner groupId={Number(groupId)} />;
}

const root = createRoot(document.getElementById('root')!);
root.render(<React.StrictMode><App /></React.StrictMode>);
