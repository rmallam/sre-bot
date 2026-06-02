import { useState } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { OverviewPage } from './pages/OverviewPage';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { RunsPage } from './pages/RunsPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { IgnoredPage } from './pages/IgnoredPage';
import { ChatPage } from './pages/ChatPage';

function Shell() {
  const [live, setLive] = useState(true);
  const location = useLocation();

  const titles: Record<string, string> = {
    '/': 'Overview',
    '/approvals': 'Approvals',
    '/runs': 'Resources & remediation',
    '/ignored': 'Ignored resources',
    '/chat': 'Assistant',
  };

  const title =
    location.pathname.startsWith('/runs/') && location.pathname.length > 6
      ? 'Run detail'
      : titles[location.pathname] ?? 'Console';

  return (
    <Layout live={live} onToggleLive={() => setLive((v) => !v)} title={title}>
      <Routes>
        <Route index element={<OverviewPage live={live} />} />
        <Route path="approvals" element={<ApprovalsPage live={live} />} />
        <Route path="runs" element={<RunsPage live={live} />} />
        <Route path="runs/:runId" element={<RunDetailPage live={live} />} />
        <Route path="ignored" element={<IgnoredPage live={live} />} />
        <Route path="chat" element={<ChatPage />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </ToastProvider>
  );
}
