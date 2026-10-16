import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Bot, RefreshCw } from "lucide-react";
import { apiUrl } from "@/lib/apiUrl";

type Finding = { level: "ok" | "info" | "warn" | "alert"; title: string; detail: string };

type ChannelLife = {
  stats: {
    hours_on: number;
    fps_avg: number | null;
    speed_avg: number | null;
    speed_min: number | null;
    q_avg: number | null;
    q_max: number | null;
    bitrate_avg: number | null;
    drops: number;
    dups: number;
    viewers_peak: number;
    restarts: number;
    errors: number;
    profile_label: string;
  };
  findings: Finding[];
  updated_at: string;
};

const LEVEL_STYLES: Record<Finding["level"], string> = {
  ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  info: "border-sky-500/40 bg-sky-500/10 text-sky-200",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  alert: "border-red-500/40 bg-red-500/10 text-red-200",
};

export function ChannelLifeDialog({
  pid,
  name,
  onOpenChange,
}: {
  pid: number | null;
  name: string;
  onOpenChange: (open: boolean) => void;
}) {
  const [data, setData] = useState<ChannelLife | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (id: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/channel-life?pid=${id}`));
      const json = await res.json();
      if (!json?.success) throw new Error(json?.error || "Sin datos");
      setData(json as ChannelLife);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo consultar el servidor");
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (pid == null) return;
    load(pid);
  }, [pid]);

  const s = data?.stats;

  const Stat = ({ label, value }: { label: string; value: string }) => (
    <div className="bg-background/40 rounded-lg p-2 border border-border/40">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono text-sm font-semibold">{value}</div>
    </div>
  );

  return (
    <Dialog open={pid != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-violet-300" />
            Vida del canal · {name}
          </DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground -mt-2">
          Conclusiones del servidor sobre las últimas 48 horas de este canal. Es solo información: nada de
          esto cambia la emisión. El historial se borra solo cada 2 días.
        </p>

        {loading && <div className="text-sm text-muted-foreground py-6 text-center">Analizando…</div>}
        {error && <div className="text-sm text-red-300 py-4">{error}</div>}

        {s && !loading && (
          <>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mt-2">
              <Stat label="Emitido" value={`${s.hours_on} h`} />
              <Stat label="Salida" value={s.profile_label} />
              <Stat label="FPS medio" value={s.fps_avg != null ? s.fps_avg.toFixed(1) : "—"} />
              <Stat label="Speed medio" value={s.speed_avg != null ? `${s.speed_avg.toFixed(2)}x` : "—"} />
              <Stat label="Q medio" value={s.q_avg != null ? s.q_avg.toFixed(1) : "—"} />
              <Stat label="Bitrate medio" value={s.bitrate_avg != null ? `${s.bitrate_avg} kbps` : "—"} />
              <Stat label="Pico visores" value={String(s.viewers_peak)} />
              <Stat label="Arranques" value={`${s.restarts} · ${s.errors} caídas`} />
            </div>

            <div className="space-y-2 mt-4">
              {data!.findings.map((f) => (
                <div key={f.title} className={`rounded-lg border p-3 ${LEVEL_STYLES[f.level]}`}>
                  <div className="text-sm font-semibold">{f.title}</div>
                  <div className="text-xs mt-1 leading-relaxed opacity-90">{f.detail}</div>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => pid != null && load(pid)}
              className="mt-4 inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-border/60 hover:bg-muted/40 transition-colors"
            >
              <RefreshCw className="h-3 w-3" /> Volver a analizar
            </button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
