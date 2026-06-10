import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { LoginPage } from '../pages/LoginPage';

export function AuthGate({ children }: { children: ReactNode }) {
  const { loading, authEnabled, user } = useAuth();

  if (loading) {
    return (
      <div className="login-page">
        <div className="login-card">
          <p className="login-lead">Loading…</p>
        </div>
      </div>
    );
  }

  if (authEnabled && !user) {
    return <LoginPage />;
  }

  return <>{children}</>;
}
