import React, { useCallback, useEffect, useState } from "react";
import { Ban, Eye, Loader2, RefreshCw, Undo2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";

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

export interface BannedViewer {
  ip: string;
  ua?: string;
  note?: string;
  created_at?: string;
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
  const [bans, setBans] = useState<BannedViewer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyIp, setBusyIp] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [respV, respB] = await Promise.all([
        fetch(`/api/viewers/details?pid=${encodeURIComponent(String(pid))}`),
        fetch(`/api/viewers/bans?pid=${encodeURIComponent(String(pid))}`),
      ]);
      const ct = respV.headers.get("content-type") || "";
      if (!ct.includes("application/json")) throw new Error("El detalle de visores solo está disponible en el servidor VPS");
      const data = await respV.json();
      if (!data?.success) throw new Error(data?.error || "No se pudo obtener el detalle");
      setViewers(data.viewers || []);
      try {
        const bd = await respB.json();
        if (bd?.success) setBans(bd.bans || []);
      } catch (_) { /* sin lista de baneados */ }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error desconocido");
      setViewers(null);
    } finally {
      setLoading(false);
    }
  }, [pid]);

  const banIp = useCallback(async (ip: string, ua?: string) => {
    setBusyIp(ip);
    try {
      const resp = await fetch("/api/viewers/ban", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid: String(pid), ip, ua }),
      });
      const data = await resp.json();
      if (!data?.success) throw new Error(data?.error || "No se pudo banear");
      setBans(data.bans || []);
      setViewers((prev) => (prev ? prev.filter((v) => v.ip !== ip) : prev));
      toast.success(`IP ${ip} bloqueada en ${channelName}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error al banear");
    } finally {
      setBusyIp(null);
    }
  }, [pid, channelName]);

  const unbanIp = useCallback(async (ip: string) => {
    setBusyIp(ip);
    try {
      const resp = await fetch("/api/viewers/unban", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid: String(pid), ip }),
      });
      const data = await resp.json();
      if (!data?.success) throw new Error(data?.error || "No se pudo desbanear");
      setBans(data.bans || []);
      toast.success(`IP ${ip} desbloqueada`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error al desbanear");
    } finally {
      setBusyIp(null);
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
            <button
              onClick={load}
              className="ml-auto inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-border hover:bg-muted"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Actualizar
            </button>
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="principal">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="principal">Principal{viewers ? ` (${viewers.length})` : ""}</TabsTrigger>
            <TabsTrigger value="baneados">Baneados{bans.length ? ` (${bans.length})` : ""}</TabsTrigger>
          </TabsList>

          <TabsContent value="principal" className="mt-3">
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
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">conectado {fmtDur(v.connected_ms)}</span>
                      <button
                        onClick={() => banIp(v.ip, v.user_agent)}
                        disabled={busyIp === v.ip}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 disabled:opacity-50"
                      >
                        {busyIp === v.ip ? <Loader2 className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3" />} Banear
                      </button>
                    </div>
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
          </TabsContent>

          <TabsContent value="baneados" className="mt-3">
            {bans.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center">
                No hay IPs bloqueadas en este canal.
              </div>
            ) : (
              <div className="space-y-2">
                {bans.map((b) => (
                  <div key={b.ip} className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-bold text-sm">{b.ip}</span>
                      <button
                        onClick={() => unbanIp(b.ip)}
                        disabled={busyIp === b.ip}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
                      >
                        {busyIp === b.ip ? <Loader2 className="h-3 w-3 animate-spin" /> : <Undo2 className="h-3 w-3" />} Quitar bloqueo
                      </button>
                    </div>
                    {b.created_at && (
                      <div className="text-muted-foreground">
                        Bloqueada el {new Date(b.created_at).toLocaleString()}
                      </div>
                    )}
                    {b.ua && (
                      <div className="pt-1 font-mono text-[10px] text-muted-foreground break-all">{b.ua}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};

export default ViewerDetailsDialog;
