import { useState, useEffect } from 'react';

const METRICS_HISTORY_SECONDS = 30 * 60; // 30 minutes
const METRICS_POLL_INTERVAL = 3000; // 3 seconds

export interface MetricsDataPoint {
  time: string;
  timestamp: number;
  cpu: number;
  ramPercent: number;
  ramUsedMB: number;
  rxMbps: number;
  txMbps: number;
}

export interface ServerMetrics {
  timestamp: number;
  cpu: { usage: number; cores: number };
  memory: { total: number; used: number; free: number; percent: number };
  network: { rxMbps: number; txMbps: number };
  uptime: number;
  loadAvg: number[];
}

export function useServerMetrics() {
  const [metricsHistory, setMetricsHistory] = useState<MetricsDataPoint[]>([]);
  const [latestMetrics, setLatestMetrics] = useState<ServerMetrics | null>(null);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const resp = await fetch('/api/metrics');
        if (!resp.ok) return;
        const data = await resp.json();

        const point: MetricsDataPoint = {
          time: new Date(data.timestamp).toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          timestamp: data.timestamp,
          cpu: data.cpu.usage,
          ramPercent: data.memory.percent,
          ramUsedMB: data.memory.used,
          rxMbps: data.network.rxMbps,
          txMbps: data.network.txMbps,
        };

        setLatestMetrics(data);
        setMetricsHistory(prev => {
          const cutoff = Date.now() - (METRICS_HISTORY_SECONDS * 1000);
          const filtered = prev.filter(p => p.timestamp > cutoff);
          return [...filtered, point];
        });
      } catch (e) {
        // Server not reachable, ignore
      }
    };

    fetchMetrics();
    const interval = setInterval(fetchMetrics, METRICS_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  return { metricsHistory, latestMetrics };
}
