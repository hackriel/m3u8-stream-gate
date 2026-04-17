import React from 'react';
import { useProxyStatus } from '@/hooks/useProxyStatus';

/**
 * Widget de estado del proxy SOCKS5 residencial CR (Pi5).
 * Solo se muestra dentro del tab de TIGO URL.
 * Muestra latencia, uptime y errores del proxy.
 */
export const ProxyHealthBadge: React.FC = () => {
  const status = useProxyStatus();

  if (!status) {
    return (
      <div className="bg-card/50 rounded-xl p-4 border border-border">
        <p className="text-xs text-muted-foreground">🌐 Cargando estado del proxy…</p>
      </div>
    );
  }

  const reachable = status.reachable === true;
  const dotColor = reachable
    ? (status.latencyMs && status.latencyMs > 400 ? 'bg-yellow-500' : 'bg-green-500')
    : 'bg-red-500';
  const stateLabel = reachable
    ? (status.latencyMs && status.latencyMs > 400 ? 'Lento' : 'OK')
    : 'Caído';
  const stateColor = reachable
    ? (status.latencyMs && status.latencyMs > 400 ? 'text-yellow-500' : 'text-green-500')
    : 'text-red-500';

  return (
    <div className="bg-card/50 rounded-xl p-4 border border-border">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-foreground">🥧 Pi5 (Proxy SOCKS5 — Costa Rica)</span>
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${dotColor} ${reachable ? 'animate-pulse' : ''}`}></span>
          <span className={`text-sm font-semibold ${stateColor}`}>{stateLabel}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-muted-foreground">Latencia actual:</span>{' '}
          <span className="font-mono text-foreground">{status.latencyMs != null ? `${status.latencyMs} ms` : '—'}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Promedio:</span>{' '}
          <span className="font-mono text-foreground">{status.avgLatencyMs != null ? `${status.avgLatencyMs} ms` : '—'}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Uptime (30 min):</span>{' '}
          <span className="font-mono text-foreground">{status.uptimePct != null ? `${status.uptimePct}%` : '—'}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Último ping:</span>{' '}
          <span className="font-mono text-foreground">{status.ageSeconds != null ? `${status.ageSeconds}s atrás` : '—'}</span>
        </div>
      </div>

      {!reachable && status.lastError && (
        <p className="text-xs text-red-400 mt-2 break-all">⚠️ {status.lastError}</p>
      )}
      {reachable && status.latencyMs != null && status.latencyMs > 400 && (
        <p className="text-xs text-yellow-500 mt-2">⚠️ Latencia alta — puede causar jitter en TIGO.</p>
      )}
    </div>
  );
};
