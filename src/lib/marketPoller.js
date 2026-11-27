// Framework-free polling controller for Trending (unit-testable with fake timers).
//  - one timer, one in-flight request at a time
//  - ticks are skipped while the page is hidden
//  - keeps the last GOOD data on failure and flags it stale
//  - backs off after rate limiting (HTTP 429)
export function createPoller({
  fetcher,
  intervalMs,
  staleAfterMs,
  backoffMs,
  isVisible = () => true,
  now = () => Date.now(),
  setTimer = setInterval,
  clearTimer = clearInterval,
  onChange = () => {},
  initial = null,
}) {
  let timer = null;
  let controller = null;
  let stopped = false;
  let backoffUntil = 0;
  let state = {
    data: initial?.data ?? null,
    lastOk: initial?.lastOk ?? 0,
    error: "",
    refreshing: false,
  };

  const emit = () => {
    if (!stopped) onChange(getState());
  };

  function getState() {
    const age = state.lastOk ? now() - state.lastOk : Infinity;
    return { ...state, stale: state.data !== null && (Boolean(state.error) || age > staleAfterMs) };
  }

  async function refresh({ manual = false } = {}) {
    if (stopped || state.refreshing) return false;
    if (now() < backoffUntil) {
      if (manual) {
        state = { ...state, error: "Rate limited by DexScreener. Trying again shortly." };
        emit();
      }
      return false;
    }

    controller = new AbortController();
    const own = controller;
    state = { ...state, refreshing: true };
    emit();

    try {
      const data = await fetcher(own.signal);
      if (stopped || own.signal.aborted) return false;
      state = { data, lastOk: now(), error: "", refreshing: false };
      emit();
      return true;
    } catch (err) {
      if (stopped || own.signal.aborted) return false;
      if (err?.rateLimited) backoffUntil = now() + backoffMs;
      state = { ...state, error: err?.message || "Couldn't refresh market data.", refreshing: false };
      emit();
      return false;
    } finally {
      if (controller === own) controller = null;
    }
  }

  return {
    getState,
    refresh,
    start() {
      stopped = false;
      refresh();
      timer = setTimer(() => {
        if (isVisible()) refresh();
      }, intervalMs);
    },
    // Call when the tab becomes visible again.
    onVisible() {
      if (isVisible() && (!state.lastOk || now() - state.lastOk >= intervalMs)) refresh();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      controller?.abort();
      controller = null;
      state = { ...state, refreshing: false }; // an aborted request must not leave us "refreshing"
    },
  };
}
