import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface ToastState {
  message: string;
  error?: boolean;
}

const ToastCtx = createContext<(msg: string, error?: boolean) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);

  const show = useCallback((message: string, error?: boolean) => {
    setToast({ message, error });
    setTimeout(() => setToast(null), 4000);
  }, []);

  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <div className={`toast ${toast.error ? 'error' : ''}`} role="status">
          {toast.message}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
