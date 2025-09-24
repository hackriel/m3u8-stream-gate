import React, { useEffect, useRef, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";

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

// Tipo para un proceso de emisión
interface EmissionProcess {
  m3u8: string;
  userAgent: string;
  rtmp: string;
  previewSuffix: string;
  isEmitiendo: boolean;
  elapsed: number;
  startTime: number;
  emitStatus: "idle" | "starting" | "running" | "stopping" | "error";
  emitMsg: string;
  healthPoints: Array<{ t: number; up: number }>;
  customQuality: boolean;
  videoBitrate: string;
  videoResolution: string;
}

export default function EmisorM3U8Panel() {
  const videoRefs = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const hlsRefs = [useRef<any>(null), useRef<any>(null), useRef<any>(null), useRef<any>(null), useRef<any>(null)];
  
  const [activeTab, setActiveTab] = useState("0");
  const [showDiagram, setShowDiagram] = useState(false);

  // Estado para 5 procesos independientes
  const [processes, setProcesses] = useState<EmissionProcess[]>(() => {
    const savedProcesses = [];
    for (let i = 0; i < 5; i++) {
      savedProcesses.push({
        m3u8: localStorage.getItem(`emisor_m3u8_${i}`) || "",
        userAgent: localStorage.getItem(`emisor_user_agent_${i}`) || "",
        rtmp: localStorage.getItem(`emisor_rtmp_${i}`) || "",
        previewSuffix: localStorage.getItem(`emisor_preview_suffix_${i}`) || "/video.m3u8",
        isEmitiendo: localStorage.getItem(`emisor_is_emitting_${i}`) === "true",
        elapsed: parseInt(localStorage.getItem(`emisor_elapsed_${i}`) || "0"),
        startTime: parseInt(localStorage.getItem(`emisor_start_time_${i}`) || "0"),
        emitStatus: (localStorage.getItem(`emisor_status_${i}`) as any) || "idle",
        emitMsg: localStorage.getItem(`emisor_msg_${i}`) || "",
        healthPoints: [],
        customQuality: localStorage.getItem(`emisor_custom_quality_${i}`) === "true",
        videoBitrate: localStorage.getItem(`emisor_video_bitrate_${i}`) || "2000k",
        videoResolution: localStorage.getItem(`emisor_video_resolution_${i}`) || "1920x1080"
      });
    }
    return savedProcesses;
  });

  const timerRefs = [useRef<NodeJS.Timeout | null>(null), useRef<NodeJS.Timeout | null>(null), useRef<NodeJS.Timeout | null>(null), useRef<NodeJS.Timeout | null>(null), useRef<NodeJS.Timeout | null>(null)];

  // Configuraciones automáticas por proveedor
  const providerConfigs = {
    'instantvideocloud.net': {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      description: 'Instant Video Cloud'
    },
    'cdnmedia.tv': {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', 
      description: 'CDN Media TV'
    },
    'liveingesta': {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      description: 'Live Ingesta'
    }
  };

  // Función para detectar proveedor y autocompletar campos
  const detectProviderAndFill = (url: string, processIndex: number) => {
    if (!url) return;
    
    for (const [domain, config] of Object.entries(providerConfigs)) {
      if (url.includes(domain)) {
        updateProcess(processIndex, {
          userAgent: config.userAgent
        });
        
        // Mostrar notificación
        console.log(`✅ Proveedor detectado: ${config.description} - User Agent configurado automáticamente`);
        break;
      }
    }
  };

  // Persistir datos en localStorage cuando cambien
  useEffect(() => {
    processes.forEach((process, index) => {
      localStorage.setItem(`emisor_m3u8_${index}`, process.m3u8);
      localStorage.setItem(`emisor_user_agent_${index}`, process.userAgent);
      localStorage.setItem(`emisor_rtmp_${index}`, process.rtmp);
      localStorage.setItem(`emisor_preview_suffix_${index}`, process.previewSuffix);
      localStorage.setItem(`emisor_is_emitting_${index}`, process.isEmitiendo.toString());
      localStorage.setItem(`emisor_elapsed_${index}`, process.elapsed.toString());
      localStorage.setItem(`emisor_start_time_${index}`, process.startTime.toString());
      localStorage.setItem(`emisor_status_${index}`, process.emitStatus);
      localStorage.setItem(`emisor_msg_${index}`, process.emitMsg);
      localStorage.setItem(`emisor_custom_quality_${index}`, process.customQuality.toString());
      localStorage.setItem(`emisor_video_bitrate_${index}`, process.videoBitrate);
      localStorage.setItem(`emisor_video_resolution_${index}`, process.videoResolution);
    });
  }, [processes]);

  // Función para actualizar un proceso específico
  const updateProcess = (index: number, updates: Partial<EmissionProcess>) => {
    setProcesses(prev => prev.map((process, i) => 
      i === index ? { ...process, ...updates } : process
    ));
  };

  // Restaurar sesiones al cargar
  useEffect(() => {
    processes.forEach((process, index) => {
      if (process.isEmitiendo && process.startTime > 0) {
        const now = Math.floor(Date.now() / 1000);
        const calculatedElapsed = now - process.startTime;
        
        updateProcess(index, {
          elapsed: calculatedElapsed > 0 ? calculatedElapsed : 0,
          emitStatus: "running",
          emitMsg: "Emisión restaurada desde sesión persistente"
        });
        
        console.log(`✅ Estado de emisión ${index + 1} restaurado, elapsed:`, calculatedElapsed);
        
        // Restaurar reproductor si hay datos guardados
        setTimeout(() => {
          if (process.rtmp) {
            const previewUrl = previewFromRTMP(process.rtmp, process.previewSuffix);
            console.log(`🔄 Restaurando reproductor ${index + 1} con URL:`, previewUrl);
            loadPreview(previewUrl, index);
          }
        }, 1000 + (index * 500)); // Delay escalonado para evitar conflictos
      }
    });
  }, []);

  // Cada 5s registramos un punto de salud para cada proceso
  useEffect(() => {
    const id = setInterval(() => {
      processes.forEach((process, index) => {
        const video = videoRefs[index].current;
        const up = video && video.readyState >= 2 && video.networkState !== 3 ? 1 : 0;
        updateProcess(index, {
          healthPoints: [
            ...process.healthPoints.slice(-119),
            { t: Math.floor(Date.now() / 1000), up }
          ]
        });
      });
    }, 5000);
    return () => clearInterval(id);
  }, [processes]);

  // Timer de reproducción para cada proceso
  useEffect(() => {
    processes.forEach((process, index) => {
      if (process.isEmitiendo) {
        if (!timerRefs[index].current) {
          timerRefs[index].current = setInterval(() => {
            updateProcess(index, { elapsed: process.elapsed + 1 });
          }, 1000);
        }
      } else {
        if (timerRefs[index].current) {
          clearInterval(timerRefs[index].current);
          timerRefs[index].current = null;
        }
      }
    });
    
    return () => {
      timerRefs.forEach(timerRef => {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      });
    };
  }, [processes]);

  const formatSeconds = (s: number) => {
    const hh = String(Math.floor(s / 3600)).padStart(2, "0");
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  };

  // Construye la URL de vista previa a partir del RTMP + sufijo.
  const previewFromRTMP = (rtmp: string, previewSuffix: string) => {
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
  async function loadPreview(url: string, processIndex: number) {
    const video = videoRefs[processIndex].current;
    if (!video || !url) {
      console.error("❌ No hay video ref o URL para cargar preview");
      return;
    }

    console.log("🎥 Cargando preview URL:", url);

    // Limpia reproducción previa si existe
    try {
      if (hlsRefs[processIndex].current) {
        hlsRefs[processIndex].current.destroy();
        hlsRefs[processIndex].current = null;
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
      video.crossOrigin = "anonymous";
      try {
        await video.play();
      } catch (e) {
        console.error("Error en reproducción nativa:", e);
      }
    } else {
      // Usar HLS.js para otros navegadores con configuración optimizada para live streaming
      try {
        const Hls = (await import("hls.js")).default;
        if (Hls.isSupported()) {
          console.log("🚀 Usando HLS.js para live streaming");
          const hls = new Hls({
            debug: false,
            enableWorker: true,
            lowLatencyMode: true,
            
            // Configuración específica para live streaming
            liveSyncDurationCount: 2,
            liveMaxLatencyDurationCount: 5,
            liveDurationInfinity: true,
            
            // Buffer configuration para live
            maxBufferLength: 10,
            maxMaxBufferLength: 20,
            backBufferLength: 30,
            
            // Fragment loading
            maxFragLookUpTolerance: 0.25,
            fragLoadingTimeOut: 10000,
            manifestLoadingTimeOut: 10000,
            
            // Retry configuration
            fragLoadingMaxRetry: 4,
            manifestLoadingMaxRetry: 4,
            levelLoadingMaxRetry: 4,
            
            // CORS and headers
            xhrSetup: (xhr: XMLHttpRequest, url: string) => {
              try {
                xhr.setRequestHeader("Cache-Control", "no-cache");
                xhr.setRequestHeader("Pragma", "no-cache");
                const process = processes[processIndex];
                if (process.userAgent) {
                  xhr.setRequestHeader("X-Requested-User-Agent", process.userAgent);
                }
              } catch (e) {
                console.error("Error setting headers:", e);
              }
            },
            
            // Auto start load
            autoStartLoad: true,
            startPosition: -1, // Para live streams, empezar desde el final
          });
          
          hlsRefs[processIndex].current = hls;
          
          // Event listeners mejorados para live streaming
          hls.on(Hls.Events.MEDIA_ATTACHED, () => {
            console.log("📺 HLS media attached, loading source...");
            hls.loadSource(url);
          });
          
          hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
            console.log("📄 HLS manifest parsed:", data);
            console.log("Levels available:", data.levels?.length || 0);
            
            // Para live streams, intentar reproducir automáticamente
            const isLive = data.levels && data.levels.length > 0 && data.levels[0].details?.live;
            if (isLive) {
              console.log("🔴 Live stream detected, starting playback");
              video.play().then(() => {
                console.log("✅ Auto-play successful");
              }).catch(e => {
                console.warn("⚠️ Auto-play failed, user interaction required:", e);
              });
            } else {
              console.log("📹 VOD/Unknown stream type, attempting playback");
              video.play().catch(e => console.error("Error playing stream:", e));
            }
          });
          
          hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
            console.log(`📊 Quality switched to level ${data.level}`);
          });
          
          hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
            console.log("📦 Fragment loaded:", data.frag.sn);
          });
          
          hls.on(Hls.Events.ERROR, (event: any, data: any) => {
            console.error("❌ HLS Error:", {
              type: data.type,
              details: data.details,
              fatal: data.fatal,
              response: data.response,
              url: data.url
            });
            
            if (data.fatal) {
              switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                  console.log("🔄 Recovering from network error...");
                  setTimeout(() => {
                    hls.startLoad();
                  }, 1000);
                  break;
                  
                case Hls.ErrorTypes.MEDIA_ERROR:
                  console.log("🔄 Recovering from media error...");
                  hls.recoverMediaError();
                  break;
                  
                default:
                  console.log("💥 Fatal error, destroying and trying fallback");
                  hls.destroy();
                  hlsRefs[processIndex].current = null;
                  
                  // Fallback: intentar reproducción directa
                  console.log("🆘 Trying direct video fallback");
                  video.src = url;
                  video.crossOrigin = "anonymous";
                  video.load();
                  
                  setTimeout(() => {
                    video.play().catch(e => {
                      console.error("❌ Direct playback also failed:", e);
                    });
                  }, 1000);
                  break;
              }
            } else {
              // Errores no fatales
              switch (data.details) {
                case Hls.ErrorDetails.FRAG_LOAD_TIMEOUT:
                case Hls.ErrorDetails.FRAG_LOAD_ERROR:
                  console.log("⚠️ Fragment error, will retry");
                  break;
                  
                case Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT:
                case Hls.ErrorDetails.MANIFEST_LOAD_ERROR:
                  console.log("⚠️ Manifest error, will retry");
                  break;
              }
            }
          });
          
          // Event listeners para el elemento video
          video.addEventListener('loadstart', () => console.log("🎬 Video load started"));
          video.addEventListener('loadedmetadata', () => console.log("📊 Video metadata loaded"));
          video.addEventListener('canplay', () => console.log("▶️ Video can start playing"));
          video.addEventListener('playing', () => console.log("🎵 Video is playing"));
          video.addEventListener('waiting', () => console.log("⏳ Video is buffering"));
          video.addEventListener('error', (e) => console.error("🎥 Video element error:", e));
          
          hls.attachMedia(video);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          console.log("📱 HLS.js not supported, trying native HLS");
          video.src = url;
          video.crossOrigin = "anonymous";
          await video.play();
        } else {
          console.log("⚠️ No HLS support detected, trying direct URL");
          video.src = url;
          video.crossOrigin = "anonymous";
          await video.play();
        }
      } catch (e) {
        console.error("❌ Error loading HLS.js or setting up player:", e);
        
        // Último recurso: reproducción directa
        console.log("🆘 Last resort: direct video element");
        try {
          video.src = url;
          video.crossOrigin = "anonymous";
          video.load();
          await video.play();
        } catch (playError) {
          console.error("❌ All playback methods failed:", playError);
        }
      }
    }
  }

  // --- Acciones de emisión hacia RTMP (vía backend) ---
  async function startEmitToRTMP(processIndex: number) {
    const process = processes[processIndex];
    if (!process.m3u8 || !process.rtmp) {
      updateProcess(processIndex, {
        emitStatus: "error",
        emitMsg: "Falta M3U8 o RTMP"
      });
      return;
    }
    
    updateProcess(processIndex, {
      emitStatus: "starting",
      emitMsg: "Iniciando emisión en el servidor..."
    });

    try {
      const resp = await fetch("/api/emit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-User-Agent": process.userAgent || navigator.userAgent,
        },
        body: JSON.stringify({ 
          source_m3u8: process.m3u8, 
          target_rtmp: process.rtmp, 
          user_agent: process.userAgent || null,
          process_id: processIndex.toString(),
          custom_quality: process.customQuality,
          video_bitrate: process.videoBitrate,
          video_resolution: process.videoResolution
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json().catch(() => ({}));
      
      updateProcess(processIndex, {
        emitStatus: "running",
        emitMsg: data?.message || "Emitiendo a RTMP",
        elapsed: 0,
        startTime: Math.floor(Date.now() / 1000),
        isEmitiendo: true
      });

      // Cargar preview desde RTMP
      const previewUrl = previewFromRTMP(process.rtmp, process.previewSuffix);
      console.log(`🔄 Iniciando preview ${processIndex + 1} con URL:`, previewUrl);
      if (previewUrl) {
        setTimeout(() => {
          loadPreview(previewUrl, processIndex);
        }, 2000);
      }
    } catch (e: any) {
      updateProcess(processIndex, {
        emitStatus: "error",
        emitMsg: `No se pudo iniciar la emisión: ${e.message}`,
        isEmitiendo: false
      });
    }
  }

  async function stopEmit(processIndex: number) {
    updateProcess(processIndex, {
      emitStatus: "stopping",
      emitMsg: "Deteniendo emisión en el servidor..."
    });
    
    try {
      const resp = await fetch("/api/emit/stop", { 
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ process_id: processIndex.toString() })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      await resp.json().catch(() => ({}));
    } catch (e) {
      console.error("Error stopping emit:", e);
    }

    try {
      if (hlsRefs[processIndex].current) {
        hlsRefs[processIndex].current.destroy();
        hlsRefs[processIndex].current = null;
      }
      const video = videoRefs[processIndex].current;
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    } catch {}

    updateProcess(processIndex, {
      isEmitiendo: false,
      elapsed: 0,
      startTime: 0,
      emitStatus: "idle",
      emitMsg: ""
    });
    
    // Limpiar localStorage de emisión pero mantener datos de entrada
    localStorage.removeItem(`emisor_is_emitting_${processIndex}`);
    localStorage.removeItem(`emisor_elapsed_${processIndex}`);
    localStorage.removeItem(`emisor_start_time_${processIndex}`);
    localStorage.removeItem(`emisor_status_${processIndex}`);
    localStorage.removeItem(`emisor_msg_${processIndex}`);
  }

  function onBorrar(processIndex: number) {
    const process = processes[processIndex];
    
    // Primero detener emisión si está activa
    if (process.isEmitiendo) {
      stopEmit(processIndex);
    }
    
    // Limpiar campos
    updateProcess(processIndex, {
      m3u8: "",
      userAgent: "",
      rtmp: "",
      previewSuffix: "/video.m3u8"
    });
    
    // Limpiar localStorage de todos los datos
    localStorage.removeItem(`emisor_m3u8_${processIndex}`);
    localStorage.removeItem(`emisor_user_agent_${processIndex}`);
    localStorage.removeItem(`emisor_rtmp_${processIndex}`);
    localStorage.removeItem(`emisor_preview_suffix_${processIndex}`);
    
    // Limpiar el reproductor
    try {
      if (hlsRefs[processIndex].current) {
        hlsRefs[processIndex].current.destroy();
        hlsRefs[processIndex].current = null;
      }
      const video = videoRefs[processIndex].current;
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    } catch (e) {
      console.error("Error limpiando reproductor:", e);
    }
    
    console.log(`🧹 Proceso ${processIndex + 1} limpiado, listo para nueva configuración`);
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "starting": return "bg-warning";
      case "running": return "bg-status-live";
      case "stopping": return "bg-warning";
      case "error": return "bg-status-error";
      default: return "bg-status-idle";
    }
  };

  // Función para renderizar un tab de proceso
  const renderProcessTab = (processIndex: number) => {
    const process = processes[processIndex];
    const uptimeData = process.healthPoints.map((p) => ({
      name: new Date(p.t * 1000).toLocaleTimeString(),
      Estado: p.up ? 100 : 0,
    }));

    return (
      <div className="space-y-6">
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Panel de configuración */}
          <div className="bg-broadcast-panel/60 backdrop-blur-sm rounded-2xl p-5 shadow-lg border border-broadcast-border/50 transition-all duration-300 hover:shadow-xl">
            <h2 className="text-lg font-medium mb-4 text-accent">Fuente y Cabeceras - Proceso {processIndex + 1}</h2>

            <label className="block text-sm mb-2 text-muted-foreground">URL M3U8 (fuente)</label>
            <input
              type="url"
              placeholder="https://servidor/origen/playlist.m3u8"
              value={process.m3u8}
              onChange={(e) => {
                const newUrl = e.target.value;
                updateProcess(processIndex, { m3u8: newUrl });
                // Detectar proveedor automáticamente al cambiar URL
                detectProviderAndFill(newUrl, processIndex);
              }}
              className="w-full bg-card border border-border rounded-xl px-4 py-3 mb-4 outline-none focus:ring-2 focus:ring-primary/50 transition-all duration-200"
            />

            <label className="block text-sm mb-2 text-muted-foreground">User-Agent deseado</label>
            <input
              type="text"
              placeholder="Mozilla/5.0 (Windows NT 10.0; Win64; x64) ..."
              value={process.userAgent}
              onChange={(e) => updateProcess(processIndex, { userAgent: e.target.value })}
              className="w-full bg-card border border-border rounded-xl px-4 py-3 mb-4 outline-none focus:ring-2 focus:ring-primary/50 transition-all duration-200"
            />

            <h2 className="text-lg font-medium mb-3 text-accent">Destino RTMP</h2>
            <label className="block text-sm mb-2 text-muted-foreground">RTMP (app/stream)</label>
            <input
              type="text"
              placeholder="rtmp://fluestabiliz.giize.com/costaSTAR007"
              value={process.rtmp}
              onChange={(e) => updateProcess(processIndex, { rtmp: e.target.value })}
              className="w-full bg-card border border-border rounded-xl px-4 py-3 mb-2 outline-none focus:ring-2 focus:ring-primary/50 transition-all duration-200"
            />
            <label className="block text-xs mb-2 text-muted-foreground">Sufijo de vista previa (HLS expuesto por tu servidor)</label>
            <div className="flex gap-2 items-center mb-4">
              <code className="bg-card px-2 py-2 rounded-xl border border-border text-xs whitespace-nowrap max-w-[60%] overflow-hidden text-ellipsis">
                {process.rtmp || "rtmp://host/app/stream"}
              </code>
              <span className="text-muted-foreground text-xs">+</span>
              <input
                type="text"
                value={process.previewSuffix}
                onChange={(e) => updateProcess(processIndex, { previewSuffix: e.target.value })}
                className="flex-1 bg-card border border-border rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-primary/50 text-sm transition-all duration-200"
              />
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              Ej.: con <code className="bg-card px-1 rounded">rtmp://fluestabiliz.giize.com/costaSTAR007</code> y sufijo <code className="bg-card px-1 rounded">/video.m3u8</code> la vista previa será
              <br />
              <span className="underline break-all text-primary">{previewFromRTMP(process.rtmp, process.previewSuffix) || "rtmp://fluestabiliz.giize.com/costaSTAR007/video.m3u8"}</span>
            </p>

            {/* Controles de calidad personalizada */}
            <div className="mb-4 p-4 rounded-xl bg-card/50 border border-border">
              <div className="flex items-center gap-3 mb-3">
                <Switch
                  checked={process.customQuality}
                  onCheckedChange={(checked) => updateProcess(processIndex, { customQuality: checked })}
                />
                <label className="text-sm font-medium text-foreground cursor-pointer" onClick={() => updateProcess(processIndex, { customQuality: !process.customQuality })}>
                  🎛️ Configuración de calidad personalizada
                </label>
              </div>
              
              {process.customQuality && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
                  <div>
                    <label className="block text-xs mb-2 text-muted-foreground">Bitrate de video</label>
                    <select
                      value={process.videoBitrate}
                      onChange={(e) => updateProcess(processIndex, { videoBitrate: e.target.value })}
                      className="w-full bg-card border border-border rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                    >
                      <option value="500k">500 kbps (Calidad baja)</option>
                      <option value="1000k">1000 kbps (Calidad media)</option>
                      <option value="1500k">1500 kbps (Calidad buena)</option>
                      <option value="2000k">2000 kbps (Calidad alta)</option>
                      <option value="3000k">3000 kbps (Calidad muy alta)</option>
                      <option value="4000k">4000 kbps (Calidad máxima)</option>
                    </select>
                  </div>
                  
                  <div>
                    <label className="block text-xs mb-2 text-muted-foreground">Resolución de video</label>
                    <select
                      value={process.videoResolution}
                      onChange={(e) => updateProcess(processIndex, { videoResolution: e.target.value })}
                      className="w-full bg-card border border-border rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-primary/50 text-sm"
                    >
                      <option value="640x360">640x360 (360p)</option>
                      <option value="854x480">854x480 (480p)</option>
                      <option value="1280x720">1280x720 (720p)</option>
                      <option value="1920x1080">1920x1080 (1080p)</option>
                      <option value="2560x1440">2560x1440 (1440p)</option>
                    </select>
                  </div>
                </div>
              )}
              
              <p className="text-xs text-muted-foreground mt-2">
                {process.customQuality 
                  ? `🎥 Se aplicará recodificación con bitrate ${process.videoBitrate.replace('k', ' kbps')} y resolución ${process.videoResolution}` 
                  : "📺 Se mantendrá la calidad original del stream (copy mode)"}
              </p>
            </div>

            <div className="flex gap-3 items-center flex-wrap">
              {!process.isEmitiendo ? (
                <button 
                  onClick={() => startEmitToRTMP(processIndex)} 
                  className="px-6 py-3 rounded-xl bg-primary hover:bg-primary/90 active:scale-[.98] transition-all duration-200 font-medium text-primary-foreground shadow-lg hover:shadow-xl"
                >
                  🚀 Emitir a RTMP
                </button>
              ) : (
                <button 
                  onClick={() => stopEmit(processIndex)} 
                  className="px-6 py-3 rounded-xl bg-warning hover:bg-warning/90 active:scale-[.98] transition-all duration-200 font-medium text-warning-foreground shadow-lg hover:shadow-xl"
                >
                  ⏹️ Detener emisión
                </button>
              )}
              <button 
                onClick={() => onBorrar(processIndex)} 
                className="px-4 py-3 rounded-xl bg-destructive hover:bg-destructive/90 active:scale-[.98] transition-all duration-200 font-medium text-destructive-foreground shadow-lg hover:shadow-xl"
              >
                🗑️ Borrar
              </button>
            </div>

            {process.emitStatus !== "idle" && (
              <div className="mt-4 p-3 rounded-xl bg-card/50 border border-border">
                <div className="flex items-center gap-2 text-sm">
                  <span className={`inline-flex h-2.5 w-2.5 rounded-full ${getStatusColor(process.emitStatus)}`} />
                  <span className="text-foreground">{process.emitMsg}</span>
                </div>
              </div>
            )}
          </div>

          {/* Player */}
          <div className="bg-broadcast-panel/60 backdrop-blur-sm rounded-2xl p-4 shadow-lg border border-broadcast-border/50 transition-all duration-300 hover:shadow-xl">
            <h2 className="text-lg font-medium mb-4 text-accent">Vista previa - Proceso {processIndex + 1}</h2>
            <div className="aspect-video w-full overflow-hidden rounded-xl bg-black border border-border shadow-inner">
              <video
                ref={videoRefs[processIndex]}
                className="w-full h-full object-contain"
                controls
                playsInline
                muted
                onError={() => { /* El recolector de salud detectará caída */ }}
              />
            </div>
            <div className="mt-3 text-sm flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <span className={`inline-flex h-2.5 w-2.5 rounded-full ${process.isEmitiendo ? "bg-status-live" : "bg-status-idle"} animate-pulse`}></span>
                <span>Estado: <strong>{process.isEmitiendo ? "🔴 EN VIVO" : "⚫ Detenido"}</strong></span>
              </div>
              
              <button
                onClick={() => {
                  const testUrl = previewFromRTMP(process.rtmp, process.previewSuffix);
                  if (testUrl) {
                    console.log(`🧪 Probando reproducción manual de proceso ${processIndex + 1}:`, testUrl);
                    loadPreview(testUrl, processIndex);
                  } else {
                    console.warn("⚠️ No hay URL de preview disponible");
                  }
                }}
                className="px-3 py-1 rounded-lg bg-secondary hover:bg-secondary/90 text-secondary-foreground text-xs transition-all duration-200"
              >
                🔄 Probar reproducción
              </button>
              
              <div className="text-xs text-muted-foreground">
                URL: <code className="bg-card px-1 rounded text-[10px]">{previewFromRTMP(process.rtmp, process.previewSuffix) || "No configurada"}</code>
              </div>
            </div>

            <div className="mt-4 text-sm">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Tiempo emitiendo:</span>
                <span className="font-mono text-primary font-semibold">{formatSeconds(process.elapsed)}</span>
              </div>
            </div>
          </div>
        </section>

        {/* Tarjeta de salud rápida */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="bg-broadcast-panel/60 backdrop-blur-sm rounded-2xl p-5 shadow-lg border border-broadcast-border/50 col-span-2 transition-all duration-300 hover:shadow-xl">
            <h3 className="text-base font-medium mb-2 text-accent">Uptime reciente (~10 min) - Proceso {processIndex + 1}</h3>
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
            <h3 className="text-base font-medium mb-4 text-accent">📈 Resumen - Proceso {processIndex + 1}</h3>
            <ul className="space-y-3 text-sm">
              <li className="flex justify-between">
                <span className="text-muted-foreground">Tiempo emitiendo:</span>
                <span className="font-mono text-primary font-semibold">{formatSeconds(process.elapsed)}</span>
              </li>
              <li className="flex justify-between">
                <span className="text-muted-foreground">Puntos muestreados:</span>
                <span className="text-foreground font-semibold">{process.healthPoints.length}</span>
              </li>
              <li className="flex justify-between">
                <span className="text-muted-foreground">Último estado:</span>
                <span className={`font-semibold ${process.healthPoints.at(-1)?.up ? "text-status-live" : "text-status-error"}`}>
                  {process.healthPoints.at(-1)?.up ? "🟢 Arriba" : "🔴 Caído"}
                </span>
              </li>
            </ul>
          </div>
        </section>
      </div>
    );
  };

  return (
    <div className="min-h-screen w-full bg-background text-foreground p-6">
      <div className="max-w-6xl mx-auto">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
            Emisor M3U8 → RTMP – Panel Multi-Proceso
          </h1>
          <div className="text-sm text-muted-foreground">
            Procesos activos: <span className="font-mono text-primary">{processes.filter(p => p.isEmitiendo).length}/5</span>
          </div>
        </header>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-5 mb-6">
            <TabsTrigger value="0" className="flex items-center gap-2">
              <span className={`inline-flex h-2 w-2 rounded-full ${processes[0].isEmitiendo ? "bg-status-live animate-pulse" : "bg-status-idle"}`} />
              Proceso 1
            </TabsTrigger>
            <TabsTrigger value="1" className="flex items-center gap-2">
              <span className={`inline-flex h-2 w-2 rounded-full ${processes[1].isEmitiendo ? "bg-status-live animate-pulse" : "bg-status-idle"}`} />
              Proceso 2
            </TabsTrigger>
            <TabsTrigger value="2" className="flex items-center gap-2">
              <span className={`inline-flex h-2 w-2 rounded-full ${processes[2].isEmitiendo ? "bg-status-live animate-pulse" : "bg-status-idle"}`} />
              Proceso 3
            </TabsTrigger>
            <TabsTrigger value="3" className="flex items-center gap-2">
              <span className={`inline-flex h-2 w-2 rounded-full ${processes[3].isEmitiendo ? "bg-status-live animate-pulse" : "bg-status-idle"}`} />
              Proceso 4
            </TabsTrigger>
            <TabsTrigger value="4" className="flex items-center gap-2">
              <span className={`inline-flex h-2 w-2 rounded-full ${processes[4].isEmitiendo ? "bg-status-live animate-pulse" : "bg-status-idle"}`} />
              Proceso 5
            </TabsTrigger>
          </TabsList>

          <TabsContent value="0">
            {renderProcessTab(0)}
          </TabsContent>

          <TabsContent value="1">
            {renderProcessTab(1)}
          </TabsContent>

          <TabsContent value="2">
            {renderProcessTab(2)}
          </TabsContent>

          <TabsContent value="3">
            {renderProcessTab(3)}
          </TabsContent>

          <TabsContent value="4">
            {renderProcessTab(4)}
          </TabsContent>
        </Tabs>


        <footer className="mt-10 text-xs text-muted-foreground space-y-4">
          <div className="bg-card/30 border border-border rounded-xl p-4">
            <p className="mb-2">
              💡 <strong>Para forzar User-Agent:</strong> usa un proxy (Cloudflare Worker, FastAPI, Nginx) que reenvíe la solicitud con el UA deseado y permita CORS.
            </p>
            <details className="bg-card/50 border border-border rounded-xl p-3 mt-3">
              <summary className="cursor-pointer font-medium text-foreground hover:text-primary transition-colors">
                🔧 Ejemplo de comando ffmpeg (backend) - SIN COMPRESIÓN
              </summary>
              <pre className="whitespace-pre-wrap text-foreground/90 text-[11px] leading-5 mt-3 bg-background/50 p-3 rounded-lg overflow-x-auto">
{`ffmpeg \\
  -user_agent "Mozilla/5.0" -i "https://origen/playlist.m3u8" \\
  -c:v copy -c:a copy -f flv "rtmp://host/app/stream"`}
              </pre>
              <p className="text-muted-foreground text-[11px] mt-2">
                ⚙️ Tu endpoint /api/emit debe ejecutar algo como lo anterior. Ahora envía el stream tal como llega, sin recodificación.
              </p>
            </details>
          </div>
        </footer>
      </div>
    </div>
  );
}