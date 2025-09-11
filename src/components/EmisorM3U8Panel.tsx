import React, { useEffect, useRef, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

// ⚠️ Importante sobre User-Agent y RTMP desde el navegador:
// - No se puede cambiar el header real "User-Agent" desde JS por seguridad.
//   Usa un proxy/backend y lee el header alterno X-Requested-User-Agent.
// - El navegador NO puede "empujar" directo a RTMP. Para emitir a RTMP
//   hay que disparar un proceso en servidor (p. ej., ffmpeg) que tome la
//   fuente (m3u8) y la publique al RTMP destino. Esta UI llama endpoints
//   /api/emit (POST) y /api/emit/stop (POST) que debes implementar.

declare global {
  interface Window {
    Hls: any;
  }
}

export default function EmisorM3U8Panel() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<any>(null);

  // Inputs con persistencia en localStorage (permanente)
  const [m3u8, setM3u8] = useState(() => localStorage.getItem("emisor_m3u8") || "");
  const [userAgent, setUserAgent] = useState(() => localStorage.getItem("emisor_user_agent") || "");
  const [rtmp, setRtmp] = useState(() => localStorage.getItem("emisor_rtmp") || "");
  const [previewSuffix, setPreviewSuffix] = useState(() => localStorage.getItem("emisor_preview_suffix") || "/video.m3u8");

  // Estado con persistencia permanente
  const [isEmitiendo, setIsEmitiendo] = useState(() => localStorage.getItem("emisor_is_emitting") === "true");
  const [elapsed, setElapsed] = useState(() => parseInt(localStorage.getItem("emisor_elapsed") || "0"));
  const [startTime, setStartTime] = useState(() => parseInt(localStorage.getItem("emisor_start_time") || "0"));
  const [showDiagram, setShowDiagram] = useState(false);
  const [healthPoints, setHealthPoints] = useState<Array<{ t: number; up: number }>>([]);
  const [emitStatus, setEmitStatus] = useState<"idle" | "starting" | "running" | "stopping" | "error">(() => 
    (localStorage.getItem("emisor_status") as any) || "idle"
  );
  const [emitMsg, setEmitMsg] = useState(() => localStorage.getItem("emisor_msg") || "");

  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Persistir datos en localStorage cuando cambien (permanente)
  useEffect(() => {
    localStorage.setItem("emisor_m3u8", m3u8);
  }, [m3u8]);
  
  useEffect(() => {
    localStorage.setItem("emisor_user_agent", userAgent);
  }, [userAgent]);
  
  useEffect(() => {
    localStorage.setItem("emisor_rtmp", rtmp);
  }, [rtmp]);
  
  useEffect(() => {
    localStorage.setItem("emisor_preview_suffix", previewSuffix);
  }, [previewSuffix]);
  
  useEffect(() => {
    localStorage.setItem("emisor_is_emitting", isEmitiendo.toString());
  }, [isEmitiendo]);
  
  useEffect(() => {
    localStorage.setItem("emisor_elapsed", elapsed.toString());
  }, [elapsed]);
  
  useEffect(() => {
    localStorage.setItem("emisor_start_time", startTime.toString());
  }, [startTime]);
  
  useEffect(() => {
    localStorage.setItem("emisor_status", emitStatus);
  }, [emitStatus]);
  
  useEffect(() => {
    localStorage.setItem("emisor_msg", emitMsg);
  }, [emitMsg]);

  // Restaurar sesión al cargar (permanente)
  useEffect(() => {
    const savedIsEmitting = localStorage.getItem("emisor_is_emitting") === "true";
    const savedStartTime = parseInt(localStorage.getItem("emisor_start_time") || "0");
    
    console.log("🔄 Restaurando sesión:", { savedIsEmitting, savedStartTime });
    
    if (savedIsEmitting && savedStartTime > 0) {
      // Calcular tiempo transcurrido desde que se guardó
      const now = Math.floor(Date.now() / 1000);
      const calculatedElapsed = now - savedStartTime;
      setElapsed(calculatedElapsed > 0 ? calculatedElapsed : 0);
      
      // Restaurar estado completo
      setIsEmitiendo(true);
      setEmitStatus("running");
      setEmitMsg("Emisión restaurada desde sesión persistente");
      
      console.log("✅ Estado de emisión restaurado, elapsed:", calculatedElapsed);
      
      // Restaurar reproductor si hay datos guardados - usar estado actual
      setTimeout(() => {
        const currentRtmp = localStorage.getItem("emisor_rtmp") || "";
        const currentSuffix = localStorage.getItem("emisor_preview_suffix") || "/video.m3u8";
        
        if (currentRtmp) {
          let previewUrl = currentRtmp;
          
          // Si ya termina en .m3u8, convertir rtmp a http si es necesario
          if (currentRtmp.endsWith(".m3u8")) {
            previewUrl = currentRtmp.startsWith("rtmp://") ? currentRtmp.replace("rtmp://", "http://") : currentRtmp;
          } else {
            // Convertir rtmp:// a http:// para la vista previa
            if (currentRtmp.startsWith("rtmp://")) {
              previewUrl = currentRtmp.replace("rtmp://", "http://");
            }
            
            const joiner = previewUrl.endsWith("/") || currentSuffix.startsWith("/") ? "" : "/";
            previewUrl = `${previewUrl}${joiner}${currentSuffix}`;
          }
          
          console.log("🔄 Restaurando reproductor con URL:", previewUrl);
          loadPreview(previewUrl);
        }
      }, 1000); // Delay para asegurar que el DOM esté listo
    } else {
      console.log("ℹ️ No hay sesión activa para restaurar");
    }
  }, []);

  // Cada 5s registramos un punto de salud (1 = up, 0 = down)
  useEffect(() => {
    const id = setInterval(() => {
      const video = videoRef.current;
      const up = video && video.readyState >= 2 && video.networkState !== 3 ? 1 : 0;
      setHealthPoints((prev) => [
        ...prev.slice(-119),
        { t: Math.floor(Date.now() / 1000), up },
      ]);
    }, 5000);
    return () => clearInterval(id);
  }, []);

  // Timer de reproducción
  useEffect(() => {
    if (isEmitiendo) {
      if (!timerRef.current) {
        timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
      }
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isEmitiendo]);

  const formatSeconds = (s: number) => {
    const hh = String(Math.floor(s / 3600)).padStart(2, "0");
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  };

  // Construye la URL de vista previa a partir del RTMP + sufijo.
  // Convierte automáticamente rtmp:// a http:// para compatibilidad con navegador
  // Ejemplo: rtmp://fluestabiliz.giize.com/costaSTAR007 + "/video.m3u8"
  // Resultado: http://fluestabiliz.giize.com/costaSTAR007/video.m3u8
  const previewFromRTMP = () => {
    if (!rtmp) return "";
    
    let baseUrl = rtmp;
    // Si ya termina en .m3u8, convertir rtmp a http si es necesario
    if (rtmp.endsWith(".m3u8")) {
      return rtmp.startsWith("rtmp://") ? rtmp.replace("rtmp://", "http://") : rtmp;
    }
    
    // Convertir rtmp:// a http:// para la vista previa
    if (baseUrl.startsWith("rtmp://")) {
      baseUrl = baseUrl.replace("rtmp://", "http://");
    }
    
    const joiner = baseUrl.endsWith("/") || previewSuffix.startsWith("/") ? "" : "/";
    return `${baseUrl}${joiner}${previewSuffix}`;
  };

  // --- Control de preview local (HLS.js / nativo) mejorado ---
  async function loadPreview(url: string) {
    const video = videoRef.current;
    if (!video || !url) {
      console.error("❌ No hay video ref o URL para cargar preview");
      return;
    }

    console.log("🎥 Cargando preview URL:", url);

    // Limpia reproducción previa si existe
    try {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      video.pause();
      video.removeAttribute("src");
      video.load();
    } catch (e) {
      console.error("Error cleaning previous video:", e);
    }

    // Verificar si la URL es accesible antes de intentar cargar
    try {
      const testResponse = await fetch(url, { 
        method: 'HEAD',
        mode: 'no-cors' // Para evitar problemas de CORS en la verificación
      });
      console.log("✅ URL parece accesible, procediendo con carga");
    } catch (e) {
      console.warn("⚠️ No se pudo verificar URL, intentando cargar de todas formas:", e);
    }

    // Verificar si es Safari y puede reproducir HLS nativamente
    const canPlayNative = video.canPlayType("application/vnd.apple.mpegurl");
    
    if (canPlayNative && /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent)) {
      console.log("🍎 Usando reproducción nativa de Safari");
      video.src = url;
      try {
        await video.play();
      } catch (e) {
        console.error("Error en reproducción nativa:", e);
      }
    } else {
      // Usar HLS.js para otros navegadores
      try {
        const Hls = (await import("hls.js")).default;
        if (Hls.isSupported()) {
          console.log("🚀 Usando HLS.js");
          const hls = new Hls({
            debug: false,
            enableWorker: true,
            lowLatencyMode: true,
            backBufferLength: 90,
            maxBufferLength: 30,
            maxMaxBufferLength: 120,
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: 10,
            liveDurationInfinity: true,
            highBufferWatchdogPeriod: 2,
            nudgeOffset: 0.1,
            nudgeMaxRetry: 3,
            maxFragLookUpTolerance: 0.25,
            xhrSetup: (xhr: XMLHttpRequest, url: string) => {
              try {
                xhr.setRequestHeader("Cache-Control", "no-cache");
                if (userAgent) {
                  xhr.setRequestHeader("X-Requested-User-Agent", userAgent);
                }
              } catch (e) {
                console.error("Error setting headers:", e);
              }
            },
          });
          
          hlsRef.current = hls;
          
          // Event listeners mejorados
          hls.on(Hls.Events.MEDIA_ATTACHED, () => {
            console.log("📺 HLS media attached");
            hls.loadSource(url);
          });
          
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            console.log("📄 HLS manifest parsed");
            video.play().catch(e => console.error("Error auto-playing:", e));
          });
          
          hls.on(Hls.Events.ERROR, (event: any, data: any) => {
            console.error("❌ HLS Error:", data);
            if (data.fatal) {
              switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                  console.log("🔄 Recovering from network error");
                  hls.startLoad();
                  break;
                case Hls.ErrorTypes.MEDIA_ERROR:
                  console.log("🔄 Recovering from media error");
                  hls.recoverMediaError();
                  break;
                default:
                  console.log("💥 Fatal error, trying fallback");
                  hls.destroy();
                  hlsRef.current = null;
                  // Fallback a reproducción directa
                  video.src = url;
                  video.play().catch(() => {});
                  break;
              }
            }
          });
          
          hls.on(Hls.Events.FRAG_BUFFERED, () => {
            console.log("📦 Fragment buffered");
          });
          
          hls.attachMedia(video);
        } else {
          console.log("⚠️ HLS.js not supported, usando fallback");
          video.src = url;
          video.play().catch(e => console.error("Error en fallback:", e));
        }
      } catch (e) {
        console.error("Error loading HLS.js:", e);
        video.src = url;
        video.play().catch(e => console.error("Error en fallback final:", e));
      }
    }
  }

  // --- Acciones de emisión hacia RTMP (vía backend) ---
  async function startEmitToRTMP() {
    if (!m3u8 || !rtmp) {
      setEmitStatus("error");
      setEmitMsg("Falta M3U8 o RTMP");
      return;
    }
    setEmitStatus("starting");
    setEmitMsg("Iniciando emisión en el servidor...");

    try {
      const resp = await fetch("/api/emit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-User-Agent": userAgent || navigator.userAgent,
        },
        body: JSON.stringify({ 
          source_m3u8: m3u8, 
          target_rtmp: rtmp, 
          user_agent: userAgent || null 
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json().catch(() => ({}));
      setEmitStatus("running");
      setEmitMsg(data?.message || "Emitiendo a RTMP");
      setElapsed(0);
      setStartTime(Math.floor(Date.now() / 1000));
      setIsEmitiendo(true);

      // Cargar preview desde RTMP (ej: rtmp://.../stream/video.m3u8)
      const previewUrl = previewFromRTMP();
      console.log("🔄 Iniciando preview con URL:", previewUrl);
      if (previewUrl) {
        // Delay para dar tiempo al servidor a empezar a emitir
        setTimeout(() => {
          loadPreview(previewUrl);
        }, 2000);
      }
    } catch (e: any) {
      setEmitStatus("error");
      setEmitMsg(`No se pudo iniciar la emisión: ${e.message}`);
      setIsEmitiendo(false);
    }
  }

  async function stopEmit() {
    setEmitStatus("stopping");
    setEmitMsg("Deteniendo emisión en el servidor...");
    try {
      const resp = await fetch("/api/emit/stop", { method: "POST" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      await resp.json().catch(() => ({}));
    } catch (e) {
      console.error("Error stopping emit:", e);
      // aún así limpiamos el player local
    }

    try {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    } catch {}

    setIsEmitiendo(false);
    setElapsed(0);
    setStartTime(0);
    setEmitStatus("idle");
    setEmitMsg("");
    
    // Limpiar localStorage de emisión pero mantener datos de entrada
    localStorage.removeItem("emisor_is_emitting");
    localStorage.removeItem("emisor_elapsed");
    localStorage.removeItem("emisor_start_time");
    localStorage.removeItem("emisor_status");
    localStorage.removeItem("emisor_msg");
  }

  function onBorrar() {
    // Primero detener emisión si está activa
    if (isEmitiendo) {
      stopEmit();
    }
    
    // Limpiar campos
    setM3u8("");
    setUserAgent("");
    setRtmp("");
    setPreviewSuffix("/video.m3u8");
    
    // Limpiar localStorage de todos los datos
    localStorage.removeItem("emisor_m3u8");
    localStorage.removeItem("emisor_user_agent");
    localStorage.removeItem("emisor_rtmp");
    localStorage.removeItem("emisor_preview_suffix");
    
    // Limpiar el reproductor
    try {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    } catch (e) {
      console.error("Error limpiando reproductor:", e);
    }
    
    console.log("🧹 Campos limpiados, listo para nueva configuración");
  }

  const uptimeData = healthPoints.map((p) => ({
    name: new Date(p.t * 1000).toLocaleTimeString(),
    Estado: p.up ? 100 : 0,
  }));

  const getStatusColor = () => {
    switch (emitStatus) {
      case "starting": return "bg-warning";
      case "running": return "bg-status-live";
      case "stopping": return "bg-warning";
      case "error": return "bg-status-error";
      default: return "bg-status-idle";
    }
  };

  return (
    <div className="min-h-screen w-full bg-background text-foreground p-6">
      <div className="max-w-6xl mx-auto">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
            Emisor M3U8 → RTMP – Panel
          </h1>
          <div className="text-sm text-muted-foreground">
            Contador: <span className="font-mono text-primary">{formatSeconds(elapsed)}</span>
          </div>
        </header>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Panel de configuración */}
          <div className="bg-broadcast-panel/60 backdrop-blur-sm rounded-2xl p-5 shadow-lg border border-broadcast-border/50 transition-all duration-300 hover:shadow-xl">
            <h2 className="text-lg font-medium mb-4 text-accent">Fuente y Cabeceras</h2>

            <label className="block text-sm mb-2 text-muted-foreground">URL M3U8 (fuente)</label>
            <input
              type="url"
              placeholder="https://servidor/origen/playlist.m3u8"
              value={m3u8}
              onChange={(e) => setM3u8(e.target.value)}
              className="w-full bg-card border border-border rounded-xl px-4 py-3 mb-4 outline-none focus:ring-2 focus:ring-primary/50 transition-all duration-200"
            />

            <label className="block text-sm mb-2 text-muted-foreground">User-Agent deseado</label>
            <input
              type="text"
              placeholder="Mozilla/5.0 (Windows NT 10.0; Win64; x64) ..."
              value={userAgent}
              onChange={(e) => setUserAgent(e.target.value)}
              className="w-full bg-card border border-border rounded-xl px-4 py-3 mb-4 outline-none focus:ring-2 focus:ring-primary/50 transition-all duration-200"
            />

            <h2 className="text-lg font-medium mb-3 text-accent">Destino RTMP</h2>
            <label className="block text-sm mb-2 text-muted-foreground">RTMP (app/stream)</label>
            <input
              type="text"
              placeholder="rtmp://fluestabiliz.giize.com/costaSTAR007"
              value={rtmp}
              onChange={(e) => setRtmp(e.target.value)}
              className="w-full bg-card border border-border rounded-xl px-4 py-3 mb-2 outline-none focus:ring-2 focus:ring-primary/50 transition-all duration-200"
            />
            <label className="block text-xs mb-2 text-muted-foreground">Sufijo de vista previa (HLS expuesto por tu servidor)</label>
            <div className="flex gap-2 items-center mb-4">
              <code className="bg-card px-2 py-2 rounded-xl border border-border text-xs whitespace-nowrap max-w-[60%] overflow-hidden text-ellipsis">
                {rtmp || "rtmp://host/app/stream"}
              </code>
              <span className="text-muted-foreground text-xs">+</span>
              <input
                type="text"
                value={previewSuffix}
                onChange={(e) => setPreviewSuffix(e.target.value)}
                className="flex-1 bg-card border border-border rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-primary/50 text-sm transition-all duration-200"
              />
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              Ej.: con <code className="bg-card px-1 rounded">rtmp://fluestabiliz.giize.com/costaSTAR007</code> y sufijo <code className="bg-card px-1 rounded">/video.m3u8</code> la vista previa será
              <br />
              <span className="underline break-all text-primary">{previewFromRTMP() || "rtmp://fluestabiliz.giize.com/costaSTAR007/video.m3u8"}</span>
            </p>

            <div className="flex gap-3 items-center flex-wrap">
              {!isEmitiendo ? (
                <button 
                  onClick={startEmitToRTMP} 
                  className="px-6 py-3 rounded-xl bg-primary hover:bg-primary/90 active:scale-[.98] transition-all duration-200 font-medium text-primary-foreground shadow-lg hover:shadow-xl"
                >
                  🚀 Emitir a RTMP
                </button>
              ) : (
                <button 
                  onClick={stopEmit} 
                  className="px-6 py-3 rounded-xl bg-warning hover:bg-warning/90 active:scale-[.98] transition-all duration-200 font-medium text-warning-foreground shadow-lg hover:shadow-xl"
                >
                  ⏹️ Detener emisión
                </button>
              )}
              <button 
                onClick={onBorrar} 
                className="px-4 py-3 rounded-xl bg-destructive hover:bg-destructive/90 active:scale-[.98] transition-all duration-200 font-medium text-destructive-foreground shadow-lg hover:shadow-xl"
              >
                🗑️ Borrar
              </button>
              <button 
                onClick={() => setShowDiagram(true)} 
                className="ml-auto px-4 py-3 rounded-xl bg-secondary hover:bg-secondary/90 active:scale-[.98] transition-all duration-200 font-medium text-secondary-foreground shadow-lg hover:shadow-xl"
              >
                📊 Ver diagrama
              </button>
            </div>

            {emitStatus !== "idle" && (
              <div className="mt-4 p-3 rounded-xl bg-card/50 border border-border">
                <div className="flex items-center gap-2 text-sm">
                  <span className={`inline-flex h-2.5 w-2.5 rounded-full ${getStatusColor()}`} />
                  <span className="text-foreground">{emitMsg}</span>
                </div>
              </div>
            )}
          </div>

          {/* Player */}
          <div className="bg-broadcast-panel/60 backdrop-blur-sm rounded-2xl p-4 shadow-lg border border-broadcast-border/50 transition-all duration-300 hover:shadow-xl">
            <h2 className="text-lg font-medium mb-4 text-accent">Vista previa</h2>
            <div className="aspect-video w-full overflow-hidden rounded-xl bg-black border border-border shadow-inner">
              <video
                ref={videoRef}
                className="w-full h-full object-contain"
                controls
                playsInline
                muted
                onError={() => { /* El recolector de salud detectará caída */ }}
              />
            </div>
            <div className="mt-3 text-sm flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className={`inline-flex h-2.5 w-2.5 rounded-full ${isEmitiendo ? "bg-status-live" : "bg-status-idle"} animate-pulse`}></span>
                <span>Estado: <strong>{isEmitiendo ? "🔴 EN VIVO" : "⚫ Detenido"}</strong></span>
              </div>
            </div>
          </div>
        </section>

        {/* Tarjeta de salud rápida */}
        <section className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="bg-broadcast-panel/60 backdrop-blur-sm rounded-2xl p-5 shadow-lg border border-broadcast-border/50 col-span-2 transition-all duration-300 hover:shadow-xl">
            <h3 className="text-base font-medium mb-2 text-accent">Uptime reciente (~10 min)</h3>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={uptimeData} margin={{ left: 6, right: 16, top: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} hide={false} />
                  <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} width={40} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip 
                    formatter={(v) => [`${v}%`, "Estado"]} 
                    contentStyle={{ 
                      backgroundColor: "hsl(var(--card))", 
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "0.75rem",
                      color: "hsl(var(--foreground))"
                    }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="Estado" 
                    dot={false} 
                    strokeWidth={3} 
                    stroke="hsl(var(--primary))"
                    strokeLinecap="round"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="bg-broadcast-panel/60 backdrop-blur-sm rounded-2xl p-5 shadow-lg border border-broadcast-border/50 transition-all duration-300 hover:shadow-xl">
            <h3 className="text-base font-medium mb-4 text-accent">📈 Resumen</h3>
            <ul className="space-y-3 text-sm">
              <li className="flex justify-between">
                <span className="text-muted-foreground">Tiempo emitiendo:</span>
                <span className="font-mono text-primary font-semibold">{formatSeconds(elapsed)}</span>
              </li>
              <li className="flex justify-between">
                <span className="text-muted-foreground">Puntos muestreados:</span>
                <span className="text-foreground font-semibold">{healthPoints.length}</span>
              </li>
              <li className="flex justify-between">
                <span className="text-muted-foreground">Último estado:</span>
                <span className={`font-semibold ${healthPoints.at(-1)?.up ? "text-status-live" : "text-status-error"}`}>
                  {healthPoints.at(-1)?.up ? "🟢 Arriba" : "🔴 Caído"}
                </span>
              </li>
            </ul>
          </div>
        </section>

        {/* Modal diagrama detallado */}
        {showDiagram && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setShowDiagram(false)}>
            <div className="bg-card rounded-2xl w-full max-w-4xl p-6 border border-border shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xl font-semibold text-primary">📊 Diagrama de caídas / uptime</h3>
                <button 
                  onClick={() => setShowDiagram(false)} 
                  className="px-4 py-2 rounded-lg bg-secondary hover:bg-secondary/90 text-secondary-foreground transition-all duration-200"
                >
                  ✖️ Cerrar
                </button>
              </div>
              <p className="text-sm text-muted-foreground mb-4">
                La línea muestra 100% cuando el reproductor está listo (readyState ≥ 2) y 0% cuando detectamos red/errores. Para ver caídas reales del servidor RTMP/HLS, expón un endpoint de health-check y gráfalo aquí.
              </p>
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={uptimeData} margin={{ left: 6, right: 16, top: 10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                    <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} width={50} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} />
                    <Tooltip 
                      formatter={(v) => [`${v}%`, "Estado"]} 
                      contentStyle={{ 
                        backgroundColor: "hsl(var(--card))", 
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "0.75rem",
                        color: "hsl(var(--foreground))"
                      }}
                    />
                    <Line 
                      type="monotone" 
                      dataKey="Estado" 
                      dot={false} 
                      strokeWidth={3} 
                      stroke="hsl(var(--primary))"
                      strokeLinecap="round"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}

        <footer className="mt-10 text-xs text-muted-foreground space-y-4">
          <div className="bg-card/30 border border-border rounded-xl p-4">
            <p className="mb-2">
              💡 <strong>Para forzar User-Agent:</strong> usa un proxy (Cloudflare Worker, FastAPI, Nginx) que reenvíe la solicitud con el UA deseado y permita CORS.
            </p>
            <details className="bg-card/50 border border-border rounded-xl p-3 mt-3">
              <summary className="cursor-pointer font-medium text-foreground hover:text-primary transition-colors">
                🔧 Ejemplo de comando ffmpeg (backend)
              </summary>
              <pre className="whitespace-pre-wrap text-foreground/90 text-[11px] leading-5 mt-3 bg-background/50 p-3 rounded-lg overflow-x-auto">
{`ffmpeg \\
  -user_agent "${userAgent || 'Mozilla/5.0'}" -i "${m3u8 || 'https://origen/playlist.m3u8'}" \\
  -c:v copy -c:a aac -b:a 128k -f flv "${rtmp || 'rtmp://host/app/stream'}"`}
              </pre>
              <p className="text-muted-foreground text-[11px] mt-2">
                ⚙️ Tu endpoint /api/emit debe ejecutar algo como lo anterior y gestionar procesos/errores.
              </p>
            </details>
          </div>
        </footer>
      </div>
    </div>
  );
}