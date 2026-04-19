import { useTigoSrtStatus } from "@/hooks/useTigoSrtStatus";
import { Badge } from "@/components/ui/badge";
import { Activity, Radio, AlertTriangle, CheckCircle2, WifiOff } from "lucide-react";

/**
 * Panel de estado del ingest SRT desde el Pi5 (Tigo HDMI).
 * Solo visible dentro del tab de TIGO URL cuando TIGO_USE_HDMI está activo.
 */
export function TigoHdmiPanel() {
  const { status, error } = useTigoSrtStatus(2000);

  if (!status.enabled) {
    // Modo HDMI desactivado en el VPS — no renderizamos nada (queda el ProxyHealthBadge legacy)
    return null;
  }

  const connected = status.connected;
  const ageS = status.lastFrameAgeMs != null ? (status.lastFrameAgeMs / 1000).toFixed(1) : "—";
  const sinceS = status.sinceMs != null ? Math.floor(status.sinceMs / 1000) : null;

  const statusColor = error
    ? "bg-muted text-muted-foreground"
    : connected
    ? "bg-emerald-500/15 text-emerald-500 border-emerald-500/30"
    : "bg-red-500/15 text-red-500 border-red-500/30";

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-sky-500" />
          <h3 className="font-semibold text-sm">Tigo HDMI · Ingest SRT (Pi5 → VPS)</h3>
        </div>
        <Badge variant="outline" className={statusColor}>
          {error ? (
            <><WifiOff className="h-3 w-3 mr-1" /> Sin datos del backend</>
          ) : connected ? (
            <><CheckCircle2 className="h-3 w-3 mr-1" /> Conectado</>
          ) : (
            <><AlertTriangle className="h-3 w-3 mr-1" /> Esperando Pi5…</>
          )}
        </Badge>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <Metric label="Bitrate" value={`${status.bitrateKbps} kbps`} highlight={connected} />
        <Metric label="Paquetes perdidos" value={String(status.pktsLost)} warn={status.pktsLost > 0} />
        <Metric label="Último frame" value={connected ? `hace ${ageS}s` : "—"} />
        <Metric
          label="Sesión activa"
          value={sinceS != null ? formatDuration(sinceS) : "—"}
        />
      </div>

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground pt-1 border-t">
        <Activity className="h-3 w-3" />
        <span>
          Listener UDP {status.listenerPort} · Buffer {status.bufferReady ? "listo" : "calentando"} · Pi5 envía 720p30 H264 + AAC 48kHz vía SRT
        </span>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  highlight,
  warn,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-muted-foreground uppercase tracking-wide text-[10px]">{label}</div>
      <div
        className={
          "font-mono font-semibold " +
          (warn ? "text-amber-500" : highlight ? "text-emerald-500" : "text-foreground")
        }
      >
        {value}
      </div>
    </div>
  );
}

function formatDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
