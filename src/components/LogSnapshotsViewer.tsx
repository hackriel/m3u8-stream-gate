import { useEffect, useState } from "react";
import { Archive, Copy, Loader2, FileWarning } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";

type Snapshot = {
  id: string;
  process_id: number;
  reason: string;
  log_content: string;
  emit_status: string | null;
  emit_msg: string | null;
  failure_reason: string | null;
  failure_details: string | null;
  created_at: string;
};

interface LogSnapshotsViewerProps {
  processId: number;
  /** Cambiar este valor (ej: timestamp) fuerza refetch sin remount */
  refreshKey?: number;
}

/**
 * Muestra los últimos hasta 3 snapshots de logs guardados automáticamente
 * cuando un proceso termina o se detiene. Cada icono representa un snapshot;
 * click abre un modal con el log completo y un botón para copiar.
 */
export const LogSnapshotsViewer = ({ processId, refreshKey = 0 }: LogSnapshotsViewerProps) => {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/log-snapshots/${processId}`);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (!cancelled) setSnapshots(data.snapshots || []);
      } catch {
        if (!cancelled) setSnapshots([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [processId, refreshKey]);

  const open = snapshots.find((s) => s.id === openId) || null;

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Log copiado al portapapeles");
    } catch {
      toast.error("No se pudo copiar");
    }
  };

  const formatWhen = (iso: string) => {
    try {
      return new Date(iso).toLocaleString("es-CR", {
        dateStyle: "short",
        timeStyle: "medium",
      });
    } catch {
      return iso;
    }
  };

  return (
    <>
      <div className="flex items-center gap-1.5">
        {loading && snapshots.length === 0 && (
          <Loader2 className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
        )}
        {!loading && snapshots.length === 0 && (
          <span className="text-[10px] text-muted-foreground/60 italic">
            sin backups aún
          </span>
        )}
        {snapshots.map((snap, idx) => {
          const isError =
            snap.emit_status === "error" ||
            !!snap.failure_reason ||
            /inesperado|error|kill|sigterm/i.test(snap.reason);
          return (
            <button
              key={snap.id}
              onClick={() => setOpenId(snap.id)}
              title={`Backup ${idx + 1} — ${formatWhen(snap.created_at)}\n${snap.reason}`}
              className={`group inline-flex items-center justify-center h-7 w-7 rounded-md border transition-all duration-150 hover:scale-110 ${
                isError
                  ? "bg-destructive/10 border-destructive/40 text-destructive hover:bg-destructive/20"
                  : "bg-muted/40 border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {isError ? (
                <FileWarning className="h-3.5 w-3.5" />
              ) : (
                <Archive className="h-3.5 w-3.5" />
              )}
            </button>
          );
        })}
      </div>

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpenId(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Archive className="h-5 w-5 text-primary" />
              Backup de logs — Proceso {processId}
            </DialogTitle>
            {open && (
              <DialogDescription asChild>
                <div className="space-y-1 mt-2">
                  <div className="text-xs">
                    <span className="text-muted-foreground">Capturado:</span>{" "}
                    <span className="text-foreground font-medium">
                      {formatWhen(open.created_at)}
                    </span>
                  </div>
                  <div className="text-xs">
                    <span className="text-muted-foreground">Razón:</span>{" "}
                    <span className="text-foreground">{open.reason}</span>
                  </div>
                  {open.emit_status && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Estado:</span>{" "}
                      <span className="text-foreground font-mono">
                        {open.emit_status}
                      </span>
                      {open.emit_msg && (
                        <span className="text-muted-foreground">
                          {" — "}
                          {open.emit_msg}
                        </span>
                      )}
                    </div>
                  )}
                  {open.failure_reason && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Falla:</span>{" "}
                      <span className="text-destructive font-medium">
                        {open.failure_reason}
                      </span>
                      {open.failure_details && (
                        <span className="text-muted-foreground">
                          {" — "}
                          {open.failure_details}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </DialogDescription>
            )}
          </DialogHeader>

          {open && (
            <>
              <div className="flex items-center justify-between gap-2 pt-2">
                <span className="text-xs text-muted-foreground">
                  Últimas 100 líneas del log
                </span>
                <button
                  onClick={() => handleCopy(open.log_content)}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20 transition-colors"
                >
                  <Copy className="h-3 w-3" />
                  Copiar todo
                </button>
              </div>
              <pre className="flex-1 overflow-auto text-[11px] leading-relaxed font-mono bg-card border border-border rounded-lg p-3 whitespace-pre-wrap break-all text-foreground/90">
                {open.log_content}
              </pre>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};

export default LogSnapshotsViewer;