import { useAuth } from '../auth/AuthContext';

export function LoginPage() {
  const { login } = useAuth();

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <div className="sidebar-logo" aria-hidden>
            S
          </div>
          <div>
            <h1>SRE Bot</h1>
            <p>Operations Console</p>
          </div>
        </div>
        <p className="login-lead">
          Sign in with your organization account to view runs, approve remediations, and manage
          workloads in your assigned namespaces.
        </p>
        <button type="button" className="btn btn-primary login-btn" onClick={login}>
          Sign in with SSO
        </button>
      </div>
    </div>
  );
}
