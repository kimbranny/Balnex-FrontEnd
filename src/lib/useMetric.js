import { useCallback, useEffect, useRef, useState } from "react";

// Loads a read-only metric once on mount (and on key change), with manual refresh.
// - never runs two requests at once
// - keeps the last GOOD data when a refresh fails and marks it stale
// - never invents a value
export function useMetric(key, fetcher) {
  const [state, setState] = useState({ data: null, error: "", loading: true, lastOk: 0, stale: false });
  const inflight = useRef(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await fetcherRef.current();
      setState({ data, error: "", loading: false, lastOk: Date.now(), stale: false });
    } catch (err) {
      console.error("[BALNEX] analytics fetch failed", err);
      const message = /429|too many|rate/i.test(err?.message || "")
        ? "The RPC is rate-limiting requests."
        : err?.message || "Request failed.";
      setState((s) => ({ ...s, error: message, loading: false, stale: s.data !== null }));
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    setState({ data: null, error: "", loading: true, lastOk: 0, stale: false });
    load();
  }, [key, load]);

  return { ...state, refresh: load };
}
