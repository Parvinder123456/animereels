import { useState, useEffect, useRef, useCallback } from 'react';

export function useSSE(projectId) {
  const [progress, setProgress] = useState(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef(null);

  // Expose a way for the page to clear stale progress after a user action
  const clearProgress = useCallback(() => setProgress(null), []);

  useEffect(() => {
    if (!projectId) return;

    let timer = null;
    let retryDelay = 1000;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const es = new EventSource(`/api/events/${projectId}`);
      esRef.current = es;

      es.onopen = () => {
        setConnected(true);
        retryDelay = 1000;
      };

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.step === 'connected') return; // ignore initial handshake
          setProgress(data);
        } catch {
          // ignore parse errors
        }
      };

      es.onerror = () => {
        es.close();
        setConnected(false);
        // Don't clear progress — keep last known state visible
        if (!cancelled) {
          timer = setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 1.5, 5000);
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      esRef.current?.close();
    };
  }, [projectId]);

  return { progress, connected, clearProgress };
}
