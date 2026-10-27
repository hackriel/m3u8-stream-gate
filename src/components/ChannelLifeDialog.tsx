import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Bot, RefreshCw, FlaskConical } from "lucide-react";
import { Button } from '@/components/ui/button';
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
  lab_suggestion?: { channel: string; reason: string; seconds: number } | null;
};

const LEVEL_STYLES: Record<Finding["level"], string> = {
  ok: "border-success/40 bg-success/10 text-foreground",
  info: "border-primary/40 bg-primary/10 text-foreground",
  warn: "border-warning/40 bg-warning/10 text-foreground",
  alert: "border-destructive/40 bg-destructive/10 text-foreground",
};

export function ChannelLifeDialog({
  pid,
  name,
  onOpenChange,
  onLaboratory,
}: {
  pid: number | null;
  name: string;
  onOpenChange: (open: boolean) => void;
  onLaboratory?: () => void;
}) {
  const [data, setData] = useState<ChannelLife | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const runSuggested = async () => {
    if (!data?.lab_suggestion) return;
    setTesting(true);
    try {
      const response = await fetch(apiUrl('/api/laboratory/start'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Auth': sessionStorage.getItem('m3u8_dashboard_auth') || '' }, body: JSON.stringify({ channel: data.lab_suggestion.channel }), signal: AbortSignal.timeout(12000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'No se pudo iniciar la prueba.');
      onOpenChange(false); onLaboratory?.();
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo iniciar la prueba.'); }
    finally { setTesting(false); }
  };

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
            <Bot className="h-5 w-5 text-primary" />
            Vida del canal · {name}
          </DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground -mt-2">
          Observaciones técnicas de las últimas 48 horas; no son una evaluación visual ni una medición del cliente.
          Las recomendaciones no cambian la emisión. Solo se conservan los últimos 2 días.
        </p>

        {loading && <div className="text-sm text-muted-foreground py-6 text-center">Analizando…</div>}
        {error && <div role="alert" className="text-sm text-destructive py-4">{error}</div>}

        {s && !loading && (
          <>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mt-2">
              <Stat label="Emitido" value={`${s.hours_on} h`} />
              <Stat label="Salida actual" value={s.profile_label} />
              <Stat label="FPS medio" value={s.fps_avg != null ? s.fps_avg.toFixed(1) : "—"} />
              <Stat label="Speed medio" value={s.speed_avg != null ? `${s.speed_avg.toFixed(2)}x` : "—"} />
              <Stat label="Q medio" value={s.q_avg != null ? s.q_avg.toFixed(1) : "—"} />
              <Stat label="Bitrate medio" value={s.bitrate_avg != null ? `${s.bitrate_avg} kbps` : "—"} />
              <Stat label="Pico visores" value={String(s.viewers_peak)} />
              <Stat label="Arranques" value={`${s.restarts} · ${s.errors} caídas`} />
            </div>

            <div className="space-y-2 mt-4">
              {data?.findings.map((f) => (
                <div key={f.title} className={`rounded-lg border p-3 ${LEVEL_STYLES[f.level]}`}>
                  <div className="text-sm font-semibold">{f.title}</div>
                  <div className="text-xs mt-1 leading-relaxed opacity-90">{f.detail}</div>
                </div>
              ))}
            </div>

            {data?.lab_suggestion && <div className="border-t border-border pt-4 mt-4 space-y-2"><p className="text-sm">{data.lab_suggestion.reason}</p><p className="text-xs text-muted-foreground">Muestra reciente de hasta {data.lab_suggestion.seconds} s. No recupera el video de franjas antiguas ni identifica si hay fútbol.</p><Button variant="outline" disabled={testing} onClick={() => void runSuggested()}><FlaskConical className="h-4 w-4" />{testing ? 'Iniciando…' : 'Probar muestra reciente'}</Button></div>}
            <Button variant="ghost" size="sm"
              onClick={() => pid != null && load(pid)}
              className="mt-4"
            >
              <RefreshCw className="h-3 w-3" /> Volver a analizar
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
