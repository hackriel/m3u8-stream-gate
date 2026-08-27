import React, { useCallback, useEffect, useState } from "react";
import { Eye, Loader2, RefreshCw } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface ViewerInfo {
  ip: string;
  country?: string;
  region?: string;
  city?: string;
  isp?: string;
  org?: string;
  as?: string;
  proxy?: boolean;
  hosting?: boolean;
  mobile?: boolean;
  private?: boolean;
}

export interface ViewerDetail {
  ip: string;
  user_agent: string;
  hits: number;
  connected_ms: number;
  last_seen_ms: number;
  last_path?: string;
  info?: ViewerInfo | null;
}

const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
};

// Identifica qué tipo de cliente/panel está consumiendo la URL a partir del UA.
const guessClient = (ua: string): string => {
  const u = (ua || "").toLowerCase();
  if (!u) return "Desconocido";
  if (u.includes("lavf") || u.includes("ffmpeg")) return "FFmpeg / re-stream (otro panel IPTV)";
  if (u.includes("xui") || u.includes("xtream")) return "XUI / Xtream Codes";
  if (u.includes("vlc")) return "VLC";
  if (u.includes("mpv")) return "MPV";
  if (u.includes("exoplayer") || u.includes("android")) return "App Android / ExoPlayer";
  if (u.includes("iphone") || u.includes("ipad") || u.includes("appletv") || u.includes("cfnetwork")) return "iOS / Apple";
  if (u.includes("smarttv") || u.includes("tizen") || u.includes("webos")) return "Smart TV";
  if (u.includes("okhttp")) return "App móvil (okhttp)";
  if (u.includes("curl") || u.includes("wget")) return "curl / wget (script)";
  if (u.includes("chrome") || u.includes("firefox") || u.includes("safari")) return "Navegador web";
  return "Otro cliente";
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pid: number | string;
  channelName: string;
}

export const ViewerDetailsDialog: React.FC<Props> = ({ open, onOpenChange, pid, channelName }) => {
  const [loading, setLoading] = useState(false);
  const [viewers, setViewers] = useState<ViewerDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/viewers/details?pid=${encodeURIComponent(String(pid))}`);
      const ct = resp.headers.get("content-type") || "";
      if (!ct.includes("application/json")) throw new Error("El detalle de visores solo está disponible en el servidor VPS");
      const data = await resp.json();
      if (!data?.success) throw new Error(data?.error || "No se pudo obtener el detalle");
      setViewers(data.viewers || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error desconocido");
      setViewers(null);
    } finally {
      setLoading(false);
    }
  }, [pid]);

  useEffect(() => {
    if (!open) return;
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [open, load]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="h-4 w-4" />
            Visores de {channelName}
            {viewers && <span className="text-xs font-normal text-muted-foreground">({viewers.length} activos)</span>}
            <button
              onClick={load}
              className="ml-auto inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:bg-muted"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Actualizar
            </button>
          </DialogTitle>
        </DialogHeader>

        {loading && !viewers && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
          </div>
        )}

        {error && <div className="text-sm text-destructive py-4">{error}</div>}

        {viewers && viewers.length === 0 && (
          <div className="text-sm text-muted-foreground py-6 text-center">Nadie está consultando esta URL ahora mismo.</div>
        )}

        <div className="space-y-2">
          {viewers?.map((v, idx) => (
            <div key={`${v.ip}-${idx}`} className="rounded-lg border border-border bg-muted/30 p-3 text-xs space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-bold text-sm">{v.ip}</span>
                <span className="text-muted-foreground">conectado {fmtDur(v.connected_ms)}</span>
              </div>
              <div className="text-muted-foreground">
                {v.info?.city || "—"}{v.info?.region ? `, ${v.info.region}` : ""} · {v.info?.country || "—"}
              </div>
              <div>
                <span className="text-muted-foreground">Proveedor: </span>
                <span className="font-medium">{v.info?.org || v.info?.isp || "—"}</span>
                {v.info?.as && <span className="text-muted-foreground"> ({v.info.as})</span>}
              </div>
              <div>
                <span className="text-muted-foreground">Cliente: </span>
                <span className="font-medium">{guessClient(v.user_agent)}</span>
              </div>
              <div className="flex flex-wrap gap-1 pt-1">
                {v.info?.hosting && (
                  <span className="px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/15 text-amber-400">
                    Datacenter / servidor (posible re-stream)
                  </span>
                )}
                {v.info?.proxy && (
                  <span className="px-1.5 py-0.5 rounded border border-rose-500/40 bg-rose-500/15 text-rose-400">VPN / Proxy</span>
                )}
                {v.info?.mobile && (
                  <span className="px-1.5 py-0.5 rounded border border-sky-500/40 bg-sky-500/15 text-sky-400">Red móvil</span>
                )}
                {v.info?.private && (
                  <span className="px-1.5 py-0.5 rounded border border-border">Red local</span>
                )}
                <span className="px-1.5 py-0.5 rounded border border-border text-muted-foreground">{v.hits} requests</span>
                <span className="px-1.5 py-0.5 rounded border border-border text-muted-foreground">
                  visto hace {Math.round(v.last_seen_ms / 1000)}s
                </span>
              </div>
              {v.user_agent && (
                <div className="pt-1 font-mono text-[10px] text-muted-foreground break-all">{v.user_agent}</div>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ViewerDetailsDialog;
