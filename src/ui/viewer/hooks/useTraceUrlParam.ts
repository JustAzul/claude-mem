import { useCallback, useEffect, useState } from 'react';

/**
 * Syncs the active observation trace id with the URL query param `?trace=<id>`.
 *
 * State is shared module-level so every component calling this hook observes
 * the same id. Without the subscriber registry, each caller's useState was
 * independent — ObservationCard would push URL + update its own state, but
 * App's copy stayed null and the modal never rendered (F5 worked because both
 * re-parsed the URL on mount).
 */
type Listener = (id: number | null) => void;

let currentId: number | null = null;
let initialized = false;
const listeners = new Set<Listener>();

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  currentId = parseTraceParam();
}

function emit(next: number | null): void {
  currentId = next;
  listeners.forEach((fn) => fn(next));
}

export function useTraceUrlParam(): [number | null, (id: number | null) => void] {
  ensureInitialized();
  const [id, setId] = useState<number | null>(currentId);

  useEffect(() => {
    listeners.add(setId);
    const onPop = (): void => emit(parseTraceParam());
    window.addEventListener('popstate', onPop);
    return () => {
      listeners.delete(setId);
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  const setTraceId = useCallback((next: number | null): void => {
    const params = new URLSearchParams(window.location.search);
    if (next === null) {
      params.delete('trace');
    } else {
      params.set('trace', String(next));
    }
    const qs = params.toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.pushState({}, '', url);
    emit(next);
  }, []);

  return [id, setTraceId];
}

function parseTraceParam(): number | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('trace');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
