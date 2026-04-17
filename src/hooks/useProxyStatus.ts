import { useEffect, useState } from 'react';

export interface ProxyStatus {
  proxyUrl: string;
  reachable: boolean | null;
  latencyMs: number | null;
  avgLatencyMs: number | null;
  uptimePct: number | null;
  samples: number;
  lastCheck: number;
  lastError: string | null;
  ageSeconds: number | null;
}

const POLL_MS = 30_000; // dashboard refresca cada 30s; servidor pinguea cada 60s

export function useProxyStatus() {
  const [status, setStatus] = useState<ProxyStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const r = await fetch('/api/proxy-status');
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled) setStatus(data);
      } catch { /* ignore */ }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return status;
}
