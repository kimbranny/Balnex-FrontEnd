import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

const ToastContext = createContext(() => {});

// Replaces the browser alert() popups with non-blocking toasts.
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (message, type = "info") => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-3), { id, message, type }]);
      setTimeout(() => dismiss(id), type === "error" ? 7000 : 4500);
    },
    [dismiss]
  );

  const value = useMemo(() => notify, [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.type}`}>
            <span>{toast.message}</span>
            <button type="button" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// eslint-disable-next-line react/only-export-components
export function useToast() {
  return useContext(ToastContext);
}
