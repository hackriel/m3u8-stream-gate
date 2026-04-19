import { useEffect, useState } from "react";

export interface TigoSrtStatus {
  enabled: boolean;
  listenerPort: number;
  connected: boolean;
  bitrateKbps: number;
  pktsLost: number;
  lastFrameAgeMs: number | null;
  sinceMs: number | null;
  bufferReady: boolean;
}

const DEFAULT: TigoSrtStatus = {
  enabled: false,
  listenerPort: 9000,
  connected: false,
  bitrateKbps: 0,
  pktsLost: 0,
  lastFrameAgeMs: null,
  sinceMs: null,
  bufferReady: false,
};

export function useTigoSrtStatus(pollMs = 2000) {
  const [status, setStatus] = useState<TigoSrtStatus>(DEFAULT);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const res = await fetch("/api/tigo-srt-status", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as TigoSrtStatus;
        if (!cancelled) {
          setStatus({ ...DEFAULT, ...data });
          setError(null);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "fetch error");
      } finally {
        if (!cancelled) timer = setTimeout(tick, pollMs);
      }
    };

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pollMs]);

  return { status, error };
}
