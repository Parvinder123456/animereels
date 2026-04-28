import { useState, useEffect, useRef } from 'react';

export function useSSE(projectId) {
  const [progress, setProgress] = useState(null);
  const esRef = useRef(null);

  useEffect(() => {
    if (!projectId) return;

    let timer = null;
    let retryDelay = 2000;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const es = new EventSource(`/api/events/${projectId}`);
      esRef.current = es;

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          setProgress(data);
          retryDelay = 2000; // reset on successful message
        } catch {
          // ignore parse errors
        }
      };

      es.onerror = () => {
        es.close();
        if (!cancelled) {
          setProgress(null); // clear stale progress so 100% doesn't block re-triggers
          timer = setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 30000);
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

  return progress;
}
