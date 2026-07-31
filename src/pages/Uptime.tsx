import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/** Canales ocultos en el dashboard (no tiene sentido mostrarlos aquí tampoco) */
const HIDDEN = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 19]);

const NAMES: Record<number, string> = {
  0: "Disney 7", 10: "Disney 8", 11: "FUTV URL", 12: "TIGO SRT",
  13: "TELETICA URL", 14: "TDMAS 1 URL", 15: "CANAL 6 URL", 16: "DISNEY 7 SRT",
  17: "FUTV ALTERNO", 18: "FUTV SRT", 20: "Canal 6 SRT", 21: "Teletica SRT",
  22: "FOX+ SRT", 23: "FOX SRT", 24: "FOX+ URL", 25: "FOX URL",
  26: "FOX+ ALTERNO", 27: "Canal 8 URL", 28: "Canal 2 URL",
};

const COLORS: Record<number, string> = {
  0: "#9ca3af", 10: "#6366f1", 11: "#10b981", 12: "#0ea5e9", 13: "#06b6d4",
  14: "#84cc16", 15: "#f59e0b", 16: "#d1d5db", 17: "#f43f5e", 18: "#d946ef",
  20: "#ea580c", 21: "#0891b2", 22: "#ef4444", 23: "#b91c1c", 24: "#dc2626",
  25: "#991b1b", 26: "#be123c", 27: "#fb923c", 28: "#0284c7",
};

type Row = {
  id: number;
  emit_status: string | null;
  start_time: number | null;
  elapsed: number | null;
  is_emitting: boolean | null;
};

type Card = {
  id: number;
  name: string;
  color: string;
  live: boolean;
  seconds: number;
  status: string;
};

const fmt = (total: number) => {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
};

/** Decide cuántos relojes caben según la forma y tamaño de pantalla */
function autoSlots(w: number, h: number) {
  const ratio = w / h;
  if (w < 640) return 1;                 // teléfono
  if (ratio >= 1.5 && w >= 1100) return 4; // televisor / monitor ancho
  if (ratio >= 1.5) return 2;            // pantalla ancha pequeña
  return 1;                              // cuadrado tipo tablet / marco digital
}

export default function Uptime() {
  const params = new URLSearchParams(window.location.search);
  const forced = Number(params.get("count") || params.get("n") || 0);
  const rotateSec = Math.max(3, Number(params.get("rotate") || 10));

  const [rows, setRows] = useState<Row[]>([]);
  const [now, setNow] = useState(Date.now());
  const [dims, setDims] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [page, setPage] = useState(0);
  const pageRef = useRef(0);

  useEffect(() => {
    document.title = "Uptime en vivo — Emisiones";
  }, []);

  // Datos
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { data } = await supabase
        .from("emission_processes")
        .select("id, emit_status, start_time, elapsed, is_emitting");
      if (alive && data) setRows(data as Row[]);
    };
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Reloj
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Tamaño de pantalla
  useEffect(() => {
    const onResize = () => setDims({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const cards: Card[] = useMemo(() => {
    return rows
      .filter((r) => !HIDDEN.has(r.id) && NAMES[r.id])
      .map((r) => {
        const live = r.emit_status === "running" || r.emit_status === "starting";
        const seconds = live && r.start_time && r.start_time > 0
          ? Math.floor(now / 1000) - r.start_time
          : r.elapsed || 0;
        return {
          id: r.id,
          name: NAMES[r.id],
          color: COLORS[r.id] || "#22c55e",
          live,
          seconds,
          status: r.emit_status || "idle",
        };
      })
      .filter((c) => c.live)
      .sort((a, b) => b.seconds - a.seconds);
  }, [rows, now]);

  const slots = forced > 0 ? Math.min(forced, 8) : autoSlots(dims.w, dims.h);
  const pages = Math.max(1, Math.ceil(cards.length / slots));

  // Rotación
  useEffect(() => {
    if (pages <= 1) { setPage(0); pageRef.current = 0; return; }
    const t = setInterval(() => {
      pageRef.current = (pageRef.current + 1) % pages;
      setPage(pageRef.current);
    }, rotateSec * 1000);
    return () => clearInterval(t);
  }, [pages, rotateSec]);

  const visible = cards.slice(page * slots, page * slots + slots);

  const cols = slots >= 4 ? 2 : slots >= 2 ? 2 : 1;
  const rowsCount = Math.ceil(slots / cols);
  const big = slots === 1;

  return (
    <main className="min-h-screen w-full bg-background text-foreground overflow-hidden select-none">
      <div className="h-screen w-full flex flex-col p-[2vmin]">
        <header className="flex items-baseline justify-between px-[1vmin] pb-[1vmin]">
          <h1 className="text-[2.4vmin] font-semibold tracking-widest uppercase text-muted-foreground">
            Uptime en vivo
          </h1>
          <span className="text-[2vmin] text-muted-foreground tabular-nums">
            {cards.length} activo{cards.length === 1 ? "" : "s"}
            {pages > 1 ? ` · ${page + 1}/${pages}` : ""}
          </span>
        </header>

        {cards.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-[2vmin]">
            <span className="text-[10vmin] font-bold text-destructive">SIN SEÑALES</span>
            <span className="text-[2.5vmin] text-muted-foreground">Ningún canal está emitiendo</span>
          </div>
        ) : (
          <div
            className="flex-1 grid gap-[2vmin]"
            style={{
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${rowsCount}, minmax(0, 1fr))`,
            }}
          >
            {visible.map((c) => (
              <article
                key={c.id}
                className="relative rounded-[2vmin] border bg-card flex flex-col items-center justify-center overflow-hidden animate-fade-in"
                style={{ borderColor: `${c.color}55` }}
              >
                <div
                  className="absolute inset-0 opacity-[0.10]"
                  style={{ background: `radial-gradient(circle at 50% 30%, ${c.color}, transparent 70%)` }}
                />
                <div className="relative flex items-center gap-[1.2vmin] mb-[1vmin]">
                  <span
                    className="rounded-full animate-pulse"
                    style={{
                      background: c.color,
                      width: big ? "1.8vmin" : "1.4vmin",
                      height: big ? "1.8vmin" : "1.4vmin",
                    }}
                  />
                  <h2
                    className="font-semibold uppercase tracking-wider"
                    style={{ color: c.color, fontSize: big ? "4.5vmin" : "2.6vmin" }}
                  >
                    {c.name}
                  </h2>
                </div>
                <div
                  className="relative font-mono font-bold tabular-nums leading-none"
                  style={{ fontSize: big ? "20vmin" : "11vmin", color: c.color }}
                >
                  {fmt(c.seconds)}
                </div>
                <div
                  className="relative mt-[1.5vmin] text-muted-foreground tracking-widest uppercase"
                  style={{ fontSize: big ? "2.2vmin" : "1.6vmin" }}
                >
                  {Math.floor(c.seconds / 3600)}h {Math.floor((c.seconds % 3600) / 60)}m emitiendo
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
