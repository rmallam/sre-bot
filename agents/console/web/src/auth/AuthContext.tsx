import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export interface ConsoleUserInfo {
  userId: string;
  email?: string;
  name?: string;
  groups: string[];
  allowedNamespaces: string[];
}

interface AuthConfig {
  enabled: boolean;
  issuer?: string;
  clientId?: string;
  redirectUri?: string;
  sessionCookie?: boolean;
}

interface AuthState {
  loading: boolean;
  authEnabled: boolean;
  user: ConsoleUserInfo | null;
  login: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

const fetchOpts: RequestInit = { credentials: 'same-origin' };

async function fetchAuthConfig(): Promise<AuthConfig> {
  const res = await fetch('/api/auth/config', fetchOpts);
  if (!res.ok) throw new Error('Failed to load auth config');
  return res.json() as Promise<AuthConfig>;
}

async function fetchMe(): Promise<{ user: ConsoleUserInfo; authEnabled: boolean }> {
  const res = await fetch('/api/auth/me', fetchOpts);
  if (!res.ok) throw new Error('Authentication required');
  return res.json() as Promise<{ user: ConsoleUserInfo; authEnabled: boolean }>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [user, setUser] = useState<ConsoleUserInfo | null>(null);

  const refresh = useCallback(async () => {
    const config = await fetchAuthConfig();
    setAuthEnabled(config.enabled);
    if (!config.enabled) {
      const me = await fetchMe();
      setUser(me.user);
      return;
    }
    try {
      const me = await fetchMe();
      setUser(me.user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refresh()
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [refresh]);

  const login = useCallback(() => {
    const redirectUri = `${window.location.origin}/api/auth/callback`;
    window.location.href = `/api/auth/login?redirectUri=${encodeURIComponent(redirectUri)}`;
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {
      /* ignore */
    }
    setUser(null);
    window.location.href = '/';
  }, []);

  const value = useMemo(
    () => ({ loading, authEnabled, user, login, logout }),
    [loading, authEnabled, user, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
