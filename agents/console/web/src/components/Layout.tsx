import { NavLink, useLocation } from 'react-router-dom';
import { useEffect, useState, type ReactNode } from 'react';
import { fetchApprovals } from '../api';
import { NavIcon } from './NavIcon';

interface Props {
  live: boolean;
  onToggleLive: () => void;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}

const NAV = [
  { to: '/', end: true, label: 'Dashboard', icon: 'overview' as const },
  { to: '/runs', label: 'Runs', icon: 'runs' as const },
  { to: '/apps', label: 'Applications', icon: 'apps' as const },
  { to: '/activity', label: 'Activity', icon: 'activity' as const },
  { to: '/approvals', label: 'Approvals', icon: 'approvals' as const, badge: true },
  { to: '/chat', label: 'Assistant', icon: 'assistant' as const },
  { to: '/ignored', label: 'Ignored', icon: 'ignored' as const },
];

export function Layout({ live, onToggleLive, title, children, actions }: Props) {
  const [pending, setPending] = useState(0);
  const location = useLocation();
  const isChat = location.pathname === '/chat';

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
          <div className="sidebar-logo" aria-hidden>
            S
          </div>
          <div className="sidebar-brand-text">
            <h1>SRE Bot</h1>
            <p>Operations Console</p>
          </div>
        </div>
        <nav className="sidebar-nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            >
              <span className="nav-icon">
                <NavIcon name={item.icon} />
              </span>
              <span className="nav-label">{item.label}</span>
              {item.badge && pending > 0 && <span className="nav-badge">{pending}</span>}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className={`main${isChat ? ' main--chat' : ''}`}>
        {!isChat && (
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
        )}
        <main className={`content${isChat ? ' content--chat' : ''}`}>{children}</main>
      </div>
    </div>
  );
}
