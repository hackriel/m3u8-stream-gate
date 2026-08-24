import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

type Health = "green" | "yellow" | "red" | null | undefined;

const dot = (s: Health) =>
  s === "green" ? "🟢" : s === "yellow" ? "🟡" : s === "red" ? "🔴" : "⚪";

const api = async (path: string, body?: unknown) => {
  const resp = await fetch(`/api/diag${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Respuesta no válida del servidor (${resp.status})`);
  }
};

const Section = ({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <Card className="p-5 bg-card/70 border-border backdrop-blur-sm">
    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      {right}
    </div>
    {children}
  </Card>
);

const Pre = ({ children }: { children?: string }) =>
  children ? (
    <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-muted/40 p-3 text-[11px] leading-relaxed whitespace-pre-wrap">
      {children}
    </pre>
  ) : null;

const Diagnostics = () => {
  const [serverData, setServerData] = useState<any>(null);
  const [nic, setNic] = useState<any>(null);
  const [sysctl, setSysctl] = useState<any>(null);
  const [sockets, setSockets] = useState<any>(null);
  const [ffmpegData, setFfmpegData] = useState<any>(null);
  const [ingest, setIngest] = useState<any>(null);
  const [ports, setPorts] = useState<any>(null);
  const [mtu, setMtu] = useState<any>(null);
  const [routeCompare, setRouteCompare] = useState<any>(null);
  const [mtrResult, setMtrResult] = useState<any>(null);
  const [stress, setStress] = useState<any>(null);
  const [iperfStatus, setIperfStatus] = useState<any>(null);
  const [verdict, setVerdict] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [clientHost, setClientHost] = useState(() => localStorage.getItem("diag_client_host") || "");
  const [iperfPort, setIperfPort] = useState(() => localStorage.getItem("diag_iperf_port") || "5201");
  const [stepSeconds, setStepSeconds] = useState("10");

  // Monitor en vivo de una emisión real
  const [liveMon, setLiveMon] = useState<any>(null);
  const [monPid, setMonPid] = useState(() => localStorage.getItem("diag_mon_pid") || "0");
  const [monDuration, setMonDuration] = useState(() => localStorage.getItem("diag_mon_dur") || "120");

  // Telemetría en vivo de las emisiones (fps/dup/drop) para el bloque SRT/FFmpeg
  const [liveSeries, setLiveSeries] = useState<
    { t: string; fps: number; drops: number; dups: number; cpu: number; txMbps: number }[]
  >([]);
  const lastCountersRef = useRef<{ dup: number; drop: number } | null>(null);

  useEffect(() => {
    localStorage.setItem("diag_client_host", clientHost);
  }, [clientHost]);
  useEffect(() => {
    localStorage.setItem("diag_iperf_port", iperfPort);
  }, [iperfPort]);

  const guard = useCallback(async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e: any) {
      setError(e?.message || "Error ejecutando la prueba");
    } finally {
      setBusy(null);
    }
  }, []);

  // ---- Carga inicial de las pruebas read-only y seguras -------------------
  const loadReadOnly = useCallback(
    () =>
      guard("readonly", async () => {
        const [a, b, c, d, e, f, g, h] = await Promise.all([
          api("/server"),
          api("/nic"),
          api("/sysctl"),
          api("/sockets"),
          api("/ffmpeg"),
          api("/ingest"),
          api("/ports"),
          api("/iperf/status"),
        ]);
        setServerData(a);
        setNic(b);
        setSysctl(c);
        setSockets(d);
        setFfmpegData(e);
        setIngest(f);
        setPorts(g);
        setIperfStatus(h);
      }),
    [guard]
  );

  useEffect(() => {
    loadReadOnly();
  }, [loadReadOnly]);

  // ---- Telemetría en vivo -------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [statusResp, metricsResp] = await Promise.all([
          fetch("/api/status").then((r) => r.json()),
          fetch("/api/metrics").then((r) => r.json()),
        ]);
        if (cancelled) return;
        const procs: any[] = Array.isArray(statusResp?.processes)
          ? statusResp.processes
          : Object.values(statusResp?.processes || {});
        const active = procs.filter((p: any) => p?.isEmitiendo || p?.status === "running");
        const fps =
          active.reduce((acc: number, p: any) => acc + (Number(p?.fps) || 0), 0) / (active.length || 1);
        const dupTotal = active.reduce((acc: number, p: any) => acc + (Number(p?.dup ?? p?.dups) || 0), 0);
        const dropTotal = active.reduce((acc: number, p: any) => acc + (Number(p?.drop ?? p?.drops) || 0), 0);
        const prev = lastCountersRef.current;
        lastCountersRef.current = { dup: dupTotal, drop: dropTotal };
        setLiveSeries((s) =>
          [
            ...s,
            {
              t: new Date().toLocaleTimeString("es-CR", { hour12: false }),
              fps: Math.round(fps * 10) / 10,
              dups: prev ? Math.max(0, dupTotal - prev.dup) : 0,
              drops: prev ? Math.max(0, dropTotal - prev.drop) : 0,
              cpu: Number(metricsResp?.cpu?.usage) || 0,
              txMbps: Number(metricsResp?.network?.txMbps) || 0,
            },
          ].slice(-60)
        );
      } catch {
        /* servidor no alcanzable desde el preview */
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // ---- Stress test polling -----------------------------------------------
  useEffect(() => {
    if (!stress?.running) return;
    const id = setInterval(async () => {
      try {
        setStress(await api("/stress/state"));
      } catch {
        /* noop */
      }
    }, 3000);
    return () => clearInterval(id);
  }, [stress?.running]);

  const startStress = () =>
    guard("stress", async () => {
      const r = await api("/stress/start", {
        host: clientHost,
        port: Number(iperfPort),
        seconds: Number(stepSeconds),
      });
      if (r?.error) throw new Error(r.error);
      setStress(await api("/stress/state"));
    });

  const overall = useMemo(() => {
    const cpu: Health = serverData?.cpu?.status;
    const ram: Health = serverData?.memory?.status;
    const nicS: Health = nic?.status;
    const tcp: Health = sockets?.tcpStatus;
    const udp: Health = sockets?.udpStatus;
    const ff: Health = ffmpegData?.status;
    return { cpu, ram, nicS, tcp, udp, ff };
  }, [serverData, nic, sockets, ffmpegData]);

  const runVerdict = () =>
    guard("verdict", async () => {
      const v = await api("/verdict", {
        server: serverData,
        nic,
        sysctl,
        sockets,
        ffmpeg: ffmpegData,
        ingest,
        mtu,
        routeCompare,
        stress,
      });
      setVerdict(v);
    });

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/30 p-4 md:p-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-primary via-accent to-primary bg-clip-text text-transparent">
              🩺 Diagnóstico de Streaming
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Pruebas de red, kernel, NIC, sockets, rutas y capacidad real. Todas las pruebas son de solo
              lectura: no modifican sysctl, firewall, nginx, FFmpeg ni la red.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/">← Panel</Link>
            </Button>
            <Button onClick={loadReadOnly} disabled={busy === "readonly"}>
              {busy === "readonly" ? "Analizando…" : "🔄 Re-analizar servidor"}
            </Button>
          </div>
        </header>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* ---------------- Dashboard resumen ---------------- */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card className="p-4">
            <h3 className="text-sm font-semibold mb-3 text-muted-foreground">Salud del servidor</h3>
            <ul className="space-y-1.5 text-sm">
              <li>{dot(overall.cpu)} CPU · load ratio {serverData?.cpu?.loadRatio ?? "—"}</li>
              <li>{dot(overall.ram)} RAM · {serverData?.memory?.usedPercent ?? "—"}%</li>
              <li>{dot(overall.nicS)} NIC · {nic?.speedMbps ? `${nic.speedMbps} Mb/s` : "—"}</li>
              <li>{dot(serverData?.swap?.status)} Swap · {serverData?.swap?.usedMB ?? "—"} MB</li>
            </ul>
          </Card>
          <Card className="p-4">
            <h3 className="text-sm font-semibold mb-3 text-muted-foreground">Red</h3>
            <ul className="space-y-1.5 text-sm">
              <li>{dot(overall.tcp)} TCP · retrans {sockets?.tcpRetransmitsTotal ?? "—"}</li>
              <li>{dot(overall.udp)} UDP · rcvbuf err {sockets?.udpRcvbufErrors ?? "—"}</li>
              <li>
                {dot(
                  routeCompare?.clientPath?.lossPercent == null
                    ? null
                    : routeCompare.clientPath.lossPercent > 1
                      ? "red"
                      : routeCompare.clientPath.lossPercent > 0
                        ? "yellow"
                        : "green"
                )}{" "}
                Packet loss ruta · {routeCompare?.clientPath?.lossPercent ?? "—"}%
              </li>
              <li>Jitter ruta · {routeCompare?.clientPath?.jitterMs ?? "—"} ms</li>
              <li>RTT ruta · {routeCompare?.clientPath?.avgMs ?? "—"} ms</li>
            </ul>
          </Card>
          <Card className="p-4">
            <h3 className="text-sm font-semibold mb-3 text-muted-foreground">Streaming</h3>
            <ul className="space-y-1.5 text-sm">
              <li>
                {dot(ports?.rtmp?.some((p: any) => p.status === "green") ? "green" : "yellow")} RTMP ·{" "}
                {ports?.rtmp?.filter((p: any) => p.listening).map((p: any) => p.port).join(", ") || "sin listener"}
              </li>
              <li>
                {dot(ports?.srt?.some((p: any) => p.status === "green") ? "green" : "yellow")} SRT ·{" "}
                {ports?.srt?.filter((p: any) => p.listening).map((p: any) => p.port).join(", ") || "sin listener"}
              </li>
              <li>{dot(overall.ff)} FFmpeg · {ffmpegData?.count ?? 0} procesos</li>
              <li>{dot(ingest?.status)} Ingest (nginx/systemd)</li>
            </ul>
          </Card>
          <Card className="p-4">
            <h3 className="text-sm font-semibold mb-3 text-muted-foreground">Capacidad estimada</h3>
            <p className="text-2xl font-bold">
              {stress?.verdict?.stableMbps != null ? `${stress.verdict.stableMbps} Mbps` : "—"}
            </p>
            <p className="text-xs text-muted-foreground">Ancho de banda estable (UDP sin pérdida)</p>
            <p className="mt-3 text-sm">
              Degradación:{" "}
              <span className="font-semibold text-amber-400">
                {stress?.verdict?.degradesAtMbps != null ? `≈${stress.verdict.degradesAtMbps} Mbps` : "sin medir"}
              </span>
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              TCP baseline: {stress?.verdict?.tcpMbps != null ? `${stress.verdict.tcpMbps} Mbps` : "—"}
            </p>
          </Card>
        </div>

        {/* ---------------- Configuración de la prueba ---------------- */}
        <Section
          title="Configuración de las pruebas activas"
          subtitle="Necesario para iperf3, MTR y MTU: la IP pública de la red desde la que transmitís (tu PC / encoder)."
        >
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className="text-xs text-muted-foreground">IP pública de tu red / encoder</label>
              <Input value={clientHost} onChange={(e) => setClientHost(e.target.value)} placeholder="p. ej. 190.x.x.x" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Puerto iperf3</label>
              <Input value={iperfPort} onChange={(e) => setIperfPort(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Segundos por escalón</label>
              <Input value={stepSeconds} onChange={(e) => setStepSeconds(e.target.value)} />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() =>
                guard("iperfsrv", async () => {
                  const r = await api("/iperf/server", { action: iperfStatus?.running ? "stop" : "start", port: Number(iperfPort) });
                  if (r?.error) throw new Error(r.error);
                  setIperfStatus(await api("/iperf/status"));
                })
              }
              disabled={busy === "iperfsrv"}
            >
              {iperfStatus?.running ? "⏹ Detener iperf3 server" : "▶️ Iniciar iperf3 server en el VPS"}
            </Button>
            <Badge variant="outline">
              iperf3 {iperfStatus?.installed ? "instalado" : "NO instalado (apt install iperf3)"}
            </Badge>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Desde tu PC podés medir contra el VPS: <code>iperf3 -c IP_VPS -p {iperfPort}</code> (TCP) y{" "}
            <code>iperf3 -c IP_VPS -p {iperfPort} -u -b 6M</code> (UDP). Para el stress test automático, dejá
            corriendo <code>iperf3 -s -p {iperfPort}</code> en tu PC y poné arriba tu IP pública.
          </p>
        </Section>

        {/* ---------------- Stress test ---------------- */}
        <Section
          title="Stress Test de Streaming (escalera 1 → 10 Mbps)"
          subtitle="TCP baseline + UDP en 1, 2, 2.5, 3, 4, 5, 6, 8 y 10 Mbps para encontrar el punto exacto de degradación."
          right={
            <div className="flex gap-2">
              <Button onClick={startStress} disabled={busy === "stress" || stress?.running || !clientHost}>
                {stress?.running ? "Ejecutando…" : "🚀 Ejecutar stress test"}
              </Button>
              {stress?.running && (
                <Button variant="outline" onClick={() => api("/stress/stop").then(() => setStress({ ...stress, running: false }))}>
                  Detener
                </Button>
              )}
            </div>
          }
        >
          {!stress?.steps?.length && <p className="text-sm text-muted-foreground">Sin resultados todavía.</p>}
          {!!stress?.steps?.length && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-2 text-left">Escalón</th>
                    <th className="text-right">Enviado</th>
                    <th className="text-right">Recibido</th>
                    <th className="text-right">Pérdida</th>
                    <th className="text-right">Jitter</th>
                    <th className="text-right">Retrans TCP</th>
                    <th className="text-right">Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {stress.steps.map((s: any, i: number) => {
                    const loss = s.lostPercent ?? 0;
                    const jit = s.jitterMs ?? 0;
                    const ok = s.ok && loss <= 1 && jit <= 20;
                    return (
                      <tr key={i} className="border-b border-border/40">
                        <td className="py-2">{s.label}</td>
                        <td className="text-right">{s.sentMbps ?? "—"}</td>
                        <td className="text-right">{s.receivedMbps ?? "—"}</td>
                        <td className={`text-right ${loss > 1 ? "text-red-400" : loss > 0 ? "text-amber-400" : ""}`}>
                          {s.lostPercent != null ? `${s.lostPercent}%` : "—"}
                        </td>
                        <td className={`text-right ${jit > 20 ? "text-red-400" : jit > 10 ? "text-amber-400" : ""}`}>
                          {s.jitterMs != null ? `${s.jitterMs} ms` : "—"}
                        </td>
                        <td className="text-right">{s.retransmits ?? "—"}</td>
                        <td className="text-right">{s.ok ? (ok ? "🟢" : "🔴") : `⚠️ ${s.error || "falló"}`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!!stress.steps.filter((s: any) => s.protocol === "UDP" && s.ok).length && (
                <div className="mt-4 h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={stress.steps.filter((s: any) => s.protocol === "UDP" && s.ok)}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                      <XAxis dataKey="targetMbps" unit=" Mbps" fontSize={11} />
                      <YAxis fontSize={11} />
                      <Tooltip />
                      <Legend />
                      <Line type="monotone" dataKey="lostPercent" name="Pérdida %" stroke="#ef4444" dot />
                      <Line type="monotone" dataKey="jitterMs" name="Jitter ms" stroke="#f59e0b" dot />
                      <Line type="monotone" dataKey="receivedMbps" name="Recibido Mbps" stroke="#22c55e" dot />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
              {stress.verdict && (
                <p className="mt-3 text-sm">
                  📉 El enlace comienza a degradarse aproximadamente a partir de{" "}
                  <b>{stress.verdict.degradesAtMbps ?? "— (no se detectó degradación en el rango probado)"}</b>
                  {stress.verdict.degradesAtMbps ? " Mbps." : "."}
                </p>
              )}
            </div>
          )}
        </Section>

        {/* ---------------- Ruta / peering ---------------- */}
        <Section
          title="Ruta de Internet y comparación con YouTube"
          subtitle="MTR desde el VPS hacia tu red y hacia el ingest de YouTube: saltos, ASN, latencia, jitter y pérdida en el destino."
          right={
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() =>
                  guard("mtr", async () => {
                    const r = await api("/mtr", { host: clientHost, count: 50 });
                    if (r?.error) throw new Error(r.error);
                    setMtrResult(r);
                  })
                }
                disabled={busy === "mtr" || !clientHost}
              >
                MTR a tu red
              </Button>
              <Button
                onClick={() =>
                  guard("rc", async () => {
                    const r = await api("/route-compare", { clientHost, count: 50 });
                    if (r?.error) throw new Error(r.error);
                    setRouteCompare(r);
                  })
                }
                disabled={busy === "rc"}
              >
                {busy === "rc" ? "Midiendo rutas…" : "⚖️ Comparar rutas"}
              </Button>
            </div>
          }
        >
          {routeCompare ? (
            <div className="grid gap-4 md:grid-cols-2">
              {(["clientPath", "youtubePath"] as const).map((k) => {
                const p = routeCompare[k];
                return (
                  <Card key={k} className="p-4 bg-muted/20">
                    <h4 className="font-semibold mb-2">{k === "clientPath" ? "→ Tu red / servidor" : "→ YouTube (Google)"}</h4>
                    {p?.error ? (
                      <p className="text-sm text-muted-foreground">{p.error}</p>
                    ) : (
                      <ul className="text-sm space-y-1">
                        <li>Destino: {p?.host}</li>
                        <li>Saltos: {p?.hops}</li>
                        <li>Latencia media: {p?.avgMs} ms</li>
                        <li>Jitter: {p?.jitterMs} ms</li>
                        <li>Pérdida en destino: {p?.lossPercent}%</li>
                        <li className="text-xs text-muted-foreground">ASN: {(p?.asns || []).join(" · ") || "n/d"}</li>
                      </ul>
                    )}
                  </Card>
                );
              })}
              <p className="md:col-span-2 text-xs text-muted-foreground">{routeCompare.note}</p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Sin datos de ruta todavía.</p>
          )}
          {mtrResult?.hops?.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-1 text-left">#</th>
                    <th className="text-left">ASN</th>
                    <th className="text-left">Host</th>
                    <th className="text-right">Loss%</th>
                    <th className="text-right">Avg</th>
                    <th className="text-right">Worst</th>
                    <th className="text-right">Jitter</th>
                  </tr>
                </thead>
                <tbody>
                  {mtrResult.hops.map((h: any) => (
                    <tr key={h.hop} className="border-b border-border/30">
                      <td className="py-1">{h.hop}</td>
                      <td>{h.asn || "—"}</td>
                      <td className="font-mono">{h.host}</td>
                      <td className={`text-right ${h.lossPercent > 1 ? "text-amber-400" : ""}`}>{h.lossPercent}</td>
                      <td className="text-right">{h.avgMs}</td>
                      <td className="text-right">{h.worstMs}</td>
                      <td className="text-right">{h.jitterMs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* ---------------- MTU + puertos ---------------- */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Section
            title="MTU / fragmentación"
            subtitle="Búsqueda binaria con ping DF hacia el destino. Crítico para SRT/UDP."
            right={
              <Button
                variant="outline"
                onClick={() =>
                  guard("mtu", async () => {
                    const r = await api("/mtu", { host: clientHost });
                    if (r?.error) throw new Error(r.error);
                    setMtu(r);
                  })
                }
                disabled={busy === "mtu" || !clientHost}
              >
                Detectar MTU
              </Button>
            }
          >
            {mtu ? (
              <div className="text-sm space-y-1">
                <p className="text-xl font-bold">MTU detectado: {mtu.mtu ?? "—"}</p>
                <p>{dot(mtu.status)} {mtu.message}</p>
                <p className="text-xs text-muted-foreground">
                  MTU local del VPS: {mtu.localMtu ?? "—"} · payload SRT sugerido: {mtu.srtPayloadRecommendation ?? "—"}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Sin medir.</p>
            )}
          </Section>

          <Section title="Puertos SRT / RTMP" subtitle="Listeners activos, disponibilidad y reglas de firewall detectadas.">
            <div className="grid gap-4 sm:grid-cols-2 text-sm">
              <div>
                <h4 className="font-semibold mb-1">SRT (UDP)</h4>
                {(ports?.srt || []).map((p: any) => (
                  <div key={p.port} className="flex justify-between">
                    <span>{dot(p.status)} {p.port}</span>
                    <span className="text-xs text-muted-foreground">{p.listening ? "escuchando" : p.bindable ? "libre" : p.reason}</span>
                  </div>
                ))}
              </div>
              <div>
                <h4 className="font-semibold mb-1">RTMP (TCP)</h4>
                {(ports?.rtmp || []).map((p: any) => (
                  <div key={p.port} className="flex justify-between">
                    <span>{dot(p.status)} {p.port}</span>
                    <span className="text-xs text-muted-foreground">{p.listening ? "escuchando" : p.bindable ? "libre" : p.reason}</span>
                  </div>
                ))}
              </div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">{ports?.note}</p>
          </Section>
        </div>

        {/* ---------------- Kernel / NIC / sockets ---------------- */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Interfaz de red (NIC)" subtitle={`Interfaz ${nic?.iface || "—"} · ${nic?.speedMbps ? nic.speedMbps + " Mb/s " + (nic?.duplex || "") : "velocidad n/d"}`}>
            <div className="text-sm space-y-1">
              <p>{dot(nic?.status)} RX drops {nic?.rxDropPercent ?? "—"}% · TX drops {nic?.txDropPercent ?? "—"}%</p>
              <p className="text-xs text-muted-foreground">
                RX err {nic?.rx?.errors ?? "—"} · TX err {nic?.tx?.errors ?? "—"} · overrun {nic?.rx?.overrun ?? "—"}
              </p>
              {!!Object.keys(nic?.driverCounters || {}).length && (
                <div className="mt-2 text-xs">
                  <p className="font-semibold mb-1">Contadores del driver &gt; 0:</p>
                  {Object.entries(nic!.driverCounters).map(([k, v]) => (
                    <div key={k} className="flex justify-between">
                      <span className="font-mono">{k}</span>
                      <span>{String(v)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Section>

          <Section title="Buffers TCP/UDP del kernel" subtitle="Solo lectura. Las recomendaciones NO se aplican automáticamente.">
            <div className="text-sm space-y-2">
              <p>{dot(sysctl?.status)} {sysctl?.findings?.length ? `${sysctl.findings.length} hallazgo(s)` : "Valores adecuados"}</p>
              {(sysctl?.findings || []).map((f: any, i: number) => (
                <div key={i} className="rounded-lg bg-muted/30 p-2 text-xs">
                  <p>{dot(f.level)} {f.msg}</p>
                  <p className="mt-1 font-mono opacity-80">{f.suggestion}</p>
                </div>
              ))}
              <Pre>{sysctl ? JSON.stringify(sysctl.values, null, 2) : undefined}</Pre>
            </div>
          </Section>

          <Section title="Sockets (ss / netstat)" subtitle="Retransmisiones TCP, colas y errores de buffer UDP.">
            <ul className="text-sm space-y-1">
              <li>{dot(sockets?.tcpStatus)} Retransmisiones TCP: {sockets?.tcpRetransmitsTotal ?? "—"}</li>
              <li>{dot(sockets?.udpStatus)} UDP receive errors: {sockets?.udpReceiveErrors ?? "—"}</li>
              <li>RcvbufErrors: {sockets?.udpRcvbufErrors ?? "—"} · SndbufErrors: {sockets?.udpSndbufErrors ?? "—"}</li>
            </ul>
            {!!sockets?.udpQueuesNonEmpty?.length && (
              <div className="mt-2 text-xs">
                <p className="font-semibold">Sockets UDP con cola acumulada:</p>
                {sockets.udpQueuesNonEmpty.map((q: any, i: number) => (
                  <p key={i} className="font-mono">
                    recvQ {q.recvQ} · sendQ {q.sendQ} · {q.local} ← {q.peer}
                  </p>
                ))}
              </div>
            )}
            <Pre>{sockets?.raw?.summary}</Pre>
          </Section>

          <Section title="Servicio de ingestión (nginx / systemd)" subtitle="Límites configurados que pueden cortar publishers o limitar bitrate.">
            <ul className="text-sm space-y-1">
              {Object.entries(ingest?.limits || {}).map(([k, v]) => (
                <li key={k} className="font-mono text-xs">
                  {k}: {String(v)}
                </li>
              ))}
              {!Object.keys(ingest?.limits || {}).length && <li className="text-muted-foreground">Sin límites detectados en nginx.</li>}
            </ul>
            {(ingest?.findings || []).map((f: any, i: number) => (
              <p key={i} className="mt-2 text-xs">{dot(f.level)} {f.msg}</p>
            ))}
            <Pre>{ingest?.processLimits}</Pre>
          </Section>
        </div>

        {/* ---------------- FFmpeg + telemetría en vivo ---------------- */}
        <Section
          title="FFmpeg y telemetría en vivo"
          subtitle="Uso de CPU/RAM por proceso y evolución de FPS, frames duplicados y descartados de las emisiones activas."
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-1 text-left">PID</th>
                    <th className="text-right">CPU%</th>
                    <th className="text-right">RSS</th>
                    <th className="text-right">Uptime</th>
                    <th className="text-left">Salida</th>
                  </tr>
                </thead>
                <tbody>
                  {(ffmpegData?.processes || []).map((p: any) => (
                    <tr key={p.pid} className="border-b border-border/30">
                      <td className="py-1">{p.pid}</td>
                      <td className="text-right">{p.cpu}</td>
                      <td className="text-right">{p.rssMB} MB</td>
                      <td className="text-right">{Math.round(p.uptimeSec / 60)} min</td>
                      <td className="font-mono truncate max-w-[220px]">{p.outputs?.[0] || "—"}</td>
                    </tr>
                  ))}
                  {!ffmpegData?.processes?.length && (
                    <tr>
                      <td colSpan={5} className="py-3 text-muted-foreground">Sin procesos FFmpeg activos.</td>
                    </tr>
                  )}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted-foreground">
                FFmpeg consume {ffmpegData?.cpuOfMachinePercent ?? 0}% del total de la máquina ({ffmpegData?.cores ?? "—"} cores).
              </p>
            </div>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={liveSeries}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                  <XAxis dataKey="t" fontSize={10} minTickGap={40} />
                  <YAxis fontSize={10} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="fps" name="FPS medio" stroke="#22c55e" dot={false} />
                  <Line type="monotone" dataKey="drops" name="Drops/3s" stroke="#ef4444" dot={false} />
                  <Line type="monotone" dataKey="dups" name="Dups/3s" stroke="#f59e0b" dot={false} />
                  <Line type="monotone" dataKey="txMbps" name="TX Mbps" stroke="#38bdf8" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Section>

        {/* ---------------- Diagnóstico final ---------------- */}
        <Section
          title="Diagnóstico final"
          subtitle="Conclusión calculada solo con la evidencia recolectada. Si faltan pruebas, lo indica en vez de inventar porcentajes."
          right={
            <Button onClick={runVerdict} disabled={busy === "verdict"}>
              {busy === "verdict" ? "Calculando…" : "🧠 Calcular causa raíz"}
            </Button>
          }
        >
          {!verdict && <p className="text-sm text-muted-foreground">Ejecutá las pruebas y luego calculá la causa raíz.</p>}
          {verdict && !verdict.enoughData && (
            <p className="text-sm text-amber-400">⚠️ {verdict.message}</p>
          )}
          {verdict?.enoughData && (
            <div className="space-y-4">
              {verdict.probabilities ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {Object.entries(verdict.probabilities)
                    .sort((a: any, b: any) => b[1] - a[1])
                    .map(([k, v]: any) => (
                      <div key={k} className="flex items-center gap-3">
                        <span className="w-40 text-sm capitalize">{k.replace(/_/g, " ")}</span>
                        <div className="h-2 flex-1 rounded-full bg-muted">
                          <div className="h-2 rounded-full bg-primary" style={{ width: `${v}%` }} />
                        </div>
                        <span className="w-10 text-right text-sm">{v}%</span>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Sin anomalías medibles: no hay base para asignar porcentajes.</p>
              )}
              {verdict.topCause && (
                <div className="rounded-lg border border-primary/40 bg-primary/10 p-3">
                  <p className="text-sm font-semibold">Causa más probable</p>
                  <p className="text-sm mt-1">{verdict.topCause}</p>
                </div>
              )}
              <div>
                <p className="text-sm font-semibold mb-1">Evidencia</p>
                <ul className="list-disc pl-5 text-sm space-y-1 text-muted-foreground">
                  {verdict.evidence.map((e: string, i: number) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
};

export default Diagnostics;
