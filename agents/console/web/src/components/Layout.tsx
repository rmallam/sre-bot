import { NavLink } from 'react-router-dom';
import { useEffect, useState, type ReactNode } from 'react';
import { fetchApprovals } from '../api';

interface Props {
  live: boolean;
  onToggleLive: () => void;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}

export function Layout({ live, onToggleLive, title, children, actions }: Props) {
  const [pending, setPending] = useState(0);

  useEffect(() => {
    const load = () =>
      fetchApprovals()
        .then((d) => setPending(d.pending))
        .catch(() => setPending(0));
    load();
    const id = setInterval(load, live ? 5000 : 60000);
    return () => clearInterval(id);
  }, [live]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <h1>SRE Bot</h1>
          <p>Operations Console</p>
        </div>
        <NavLink to="/" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} end>
          Overview
        </NavLink>
        <NavLink to="/approvals" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
          Approvals
          {pending > 0 && <span className="nav-badge">{pending}</span>}
        </NavLink>
        <NavLink to="/runs" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
          Resources
        </NavLink>
        <NavLink to="/chat" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
          Assistant
        </NavLink>
        <NavLink to="/ignored" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
          Ignored
        </NavLink>
      </aside>
      <div className="main">
        <header className="topbar">
          <h2>{title}</h2>
          <div className="topbar-actions">
            {actions}
            <button
              type="button"
              className={`live-pill ${live ? 'on' : ''}`}
              onClick={onToggleLive}
              title="Auto-refresh every 5s"
            >
              {live ? 'Live' : 'Paused'}
            </button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
