// App-wide toast: toast("Saved"), toast("Marked 3 false positive", { undo }), toast(msg, { bad: true }).
import React, { createContext, useCallback, useContext, useRef, useState } from "react";

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [state, setState] = useState({ msg: "", show: false });
  const timer = useRef(null);

  const toast = useCallback((msg, { undo, bad } = {}) => {
    clearTimeout(timer.current);
    setState({ msg, undo, bad, show: true });
    timer.current = setTimeout(() => setState((s) => ({ ...s, show: false })), undo ? 6000 : 3500);
  }, []);

  const runUndo = async () => {
    const fn = state.undo;
    setState((s) => ({ ...s, show: false }));
    try { await fn?.(); } catch { toast("Undo failed", { bad: true }); }
  };

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div role="status" aria-live="polite" className={`toast ${state.show ? "show" : ""} ${state.bad ? "bad" : ""}`}>
        <span>{state.msg}</span>
        {state.undo && <button onClick={runUndo}>Undo</button>}
      </div>
    </ToastCtx.Provider>
  );
}
