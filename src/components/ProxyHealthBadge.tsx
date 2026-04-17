import React from 'react';
import { useProxyStatus } from '@/hooks/useProxyStatus';

/**
 * Widget de estado del Pi5 (proxy SOCKS5 residencial CR).
 * Solo se muestra dentro del tab de TIGO URL.
 * Incluye: latencia proxy, CPU/RAM/temp del Pi5.
 */
export const ProxyHealthBadge: React.FC = () => {
  const status = useProxyStatus();

  if (!status) {
    return (
      <div className="bg-card/50 rounded-xl p-4 border border-border">
        <p className="text-xs text-muted-foreground">🌐 Cargando estado del Pi5…</p>
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

  const pi5 = status.pi5;
  const pi5Reachable = pi5?.reachable === true;
  const cpuColor = pi5?.cpuPct == null ? 'text-foreground' :
    pi5.cpuPct > 85 ? 'text-red-500' : pi5.cpuPct > 65 ? 'text-yellow-500' : 'text-green-500';
  const ramColor = pi5?.ramPct == null ? 'text-foreground' :
    pi5.ramPct > 85 ? 'text-red-500' : pi5.ramPct > 70 ? 'text-yellow-500' : 'text-green-500';
  const tempColor = pi5?.tempC == null ? 'text-foreground' :
    pi5.tempC > 75 ? 'text-red-500' : pi5.tempC > 65 ? 'text-yellow-500' : 'text-green-500';

  return (
    <div className="bg-card/50 rounded-xl p-4 border border-border space-y-3">
      {/* Sección Proxy SOCKS5 */}
      <div>
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

      {/* Sección Hardware Pi5 */}
      <div className="border-t border-border pt-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-foreground">💻 Hardware Pi5</span>
          {pi5Reachable ? (
            <span className="text-xs text-green-500">● online</span>
          ) : (
            <span className="text-xs text-muted-foreground">● sin datos</span>
          )}
        </div>

        {pi5Reachable ? (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-muted-foreground">CPU:</span>{' '}
              <span className={`font-mono font-semibold ${cpuColor}`}>
                {pi5.cpuPct != null ? `${pi5.cpuPct}%` : '—'}
              </span>
              {pi5.loadAvg1 != null && (
                <span className="text-muted-foreground"> (load {pi5.loadAvg1.toFixed(2)})</span>
              )}
            </div>
            <div>
              <span className="text-muted-foreground">RAM:</span>{' '}
              <span className={`font-mono font-semibold ${ramColor}`}>
                {pi5.ramPct != null ? `${pi5.ramPct}%` : '—'}
              </span>
              {pi5.ramUsedMb != null && pi5.ramTotalMb != null && (
                <span className="text-muted-foreground"> ({pi5.ramUsedMb}/{pi5.ramTotalMb} MB)</span>
              )}
            </div>
            <div>
              <span className="text-muted-foreground">Temp:</span>{' '}
              <span className={`font-mono font-semibold ${tempColor}`}>
                {pi5.tempC != null ? `${pi5.tempC}°C` : '—'}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Uptime:</span>{' '}
              <span className="font-mono text-foreground">
                {pi5.uptimeSec != null ? formatUptime(pi5.uptimeSec) : '—'}
              </span>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Instalá <code className="text-foreground bg-muted px-1 rounded">scripts/pi5-stats.py</code> en el Pi5 (puerto 8080) para ver CPU/RAM/temp.
          </p>
        )}

        {pi5Reachable && pi5.cpuPct != null && pi5.cpuPct > 85 && (
          <p className="text-xs text-red-400 mt-2">⚠️ CPU saturada — puede causar jitter en el proxy.</p>
        )}
        {pi5Reachable && pi5.tempC != null && pi5.tempC > 75 && (
          <p className="text-xs text-red-400 mt-2">🌡️ Temperatura alta — riesgo de throttling térmico.</p>
        )}
      </div>
    </div>
  );
};

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
