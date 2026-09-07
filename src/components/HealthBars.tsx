import { HISTORY_BUCKETS, type HealthLevel } from "@/lib/streamHealth";

const COLORS: Record<HealthLevel, string> = {
  stable: "bg-emerald-400",
  warning: "bg-amber-400",
  critical: "bg-red-500",
};

/**
 * Barras de comportamiento: cada barra resume 30 segundos con el peor estado
 * observado en ese tramo. Verde = sano, ámbar = atención, rojo = inestable.
 * Se muestran hasta 30 barras (últimos 15 minutos).
 */
export function HealthBars({ history, className = "" }: { history: HealthLevel[]; className?: string }) {
  const bars = history.slice(-HISTORY_BUCKETS);
  const missing = Math.max(0, HISTORY_BUCKETS - bars.length);
  const minutes = Math.round((bars.length * 30) / 60);

  return (
    <div className={className}>
      <div
        className="flex items-end gap-[2px] h-7"
        title={`Comportamiento por tramos de 30s (${bars.length} tramos ≈ ${minutes} min). Verde = sano · Ámbar = atención · Rojo = inestable.`}
      >
        {Array.from({ length: missing }).map((_, i) => (
          <span key={`e${i}`} className="flex-1 rounded-[1px] bg-muted/25" style={{ height: "40%" }} />
        ))}
        {bars.map((lvl, i) => (
          <span
            key={i}
            className={`flex-1 rounded-[1px] ${COLORS[lvl]}`}
            style={{ height: lvl === "stable" ? "100%" : lvl === "warning" ? "72%" : "52%" }}
          />
        ))}
      </div>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground mt-1 text-right">
        últimos {minutes || 0} min · tramos de 30s
      </div>
    </div>
  );
}
