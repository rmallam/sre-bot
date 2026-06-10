import { NavLink, useLocation } from 'react-router-dom';
import { useEffect, useState, type ReactNode } from 'react';
import { fetchApprovals } from '../api';
import { useAuth } from '../auth/AuthContext';
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

const SIDEBAR_COLLAPSED_KEY = 'sre-console-sidebar-collapsed';

export function Layout({ live, onToggleLive, title, children, actions }: Props) {
  const [pending, setPending] = useState(0);
  const { authEnabled, user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
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

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return (
    <div className={`app-shell${collapsed ? ' app-shell--nav-collapsed' : ''}`}>
      <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
        <div className="sidebar-brand">
          <div className="sidebar-logo" aria-hidden>
            S
          </div>
          {!collapsed && (
            <div className="sidebar-brand-text">
              <h1>SRE Bot</h1>
              <p>Operations Console</p>
            </div>
          )}
          <button
            type="button"
            className="sidebar-collapse-btn"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" aria-hidden>
              {collapsed ? (
                <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
              ) : (
                <path d="M10 4L6 8l4 4" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
          </button>
        </div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            >
              <span className="nav-icon">
                <NavIcon name={item.icon} />
              </span>
              {!collapsed && <span className="nav-label">{item.label}</span>}
              {!collapsed && item.badge && pending > 0 && (
                <span className="nav-badge">{pending}</span>
              )}
              {collapsed && item.badge && pending > 0 && <span className="nav-badge-dot" />}
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
              {authEnabled && user && (
                <div className="user-chip" title={user.groups.join(', ') || 'No groups'}>
                  <span className="user-chip-name">{user.name ?? user.email ?? user.userId}</span>
                  {user.allowedNamespaces.includes('*') ? (
                    <span className="user-chip-ns">all namespaces</span>
                  ) : user.allowedNamespaces.length > 0 ? (
                    <span className="user-chip-ns">{user.allowedNamespaces.join(', ')}</span>
                  ) : null}
                  <button type="button" className="user-chip-logout" onClick={logout}>
                    Sign out
                  </button>
                </div>
              )}
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
