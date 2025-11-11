import React, { useEffect, useRef, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";

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
  rtmp: string;
  previewSuffix: string;
  isEmitiendo: boolean;
  elapsed: number;
  startTime: number;
  emitStatus: "idle" | "starting" | "running" | "stopping" | "error";
  emitMsg: string;
  reconnectAttempts: number;
  lastReconnectTime: number;
  failureReason?: string; // Razón del fallo (source, rtmp, server)
  failureDetails?: string; // Detalles específicos del fallo
}

export default function EmisorM3U8Panel() {
  const videoRefs = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const hlsRefs = [useRef<any>(null), useRef<any>(null), useRef<any>(null), useRef<any>(null)];
  
  const [activeTab, setActiveTab] = useState("0");
  const [globalHealthPoints, setGlobalHealthPoints] = useState<Array<{ t: number; up: number }>>([]);

  // Estado para 4 procesos independientes
  const [processes, setProcesses] = useState<EmissionProcess[]>(() => {
    const savedProcesses = [];
    for (let i = 0; i < 4; i++) {
      savedProcesses.push({
        m3u8: localStorage.getItem(`emisor_m3u8_${i}`) || "",
        rtmp: localStorage.getItem(`emisor_rtmp_${i}`) || "",
        previewSuffix: localStorage.getItem(`emisor_preview_suffix_${i}`) || "/video.m3u8",
        isEmitiendo: localStorage.getItem(`emisor_is_emitting_${i}`) === "true",
        elapsed: parseInt(localStorage.getItem(`emisor_elapsed_${i}`) || "0"),
        startTime: parseInt(localStorage.getItem(`emisor_start_time_${i}`) || "0"),
        emitStatus: (localStorage.getItem(`emisor_status_${i}`) as any) || "idle",
        emitMsg: localStorage.getItem(`emisor_msg_${i}`) || "",
        reconnectAttempts: 0,
        lastReconnectTime: 0,
        failureReason: localStorage.getItem(`emisor_failure_reason_${i}`) || undefined,
        failureDetails: localStorage.getItem(`emisor_failure_details_${i}`) || undefined
      });
    }
    return savedProcesses;
  });

  const timerRefs = [useRef<NodeJS.Timeout | null>(null), useRef<NodeJS.Timeout | null>(null), useRef<NodeJS.Timeout | null>(null), useRef<NodeJS.Timeout | null>(null)];
  
  // Estado específico para el proceso 4 (archivos locales)
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number>(0);

  // Limpieza de caché programada del lado del cliente (4am Costa Rica)
  useEffect(() => {
    const checkCacheClear = () => {
      const now = new Date();
      const costaRicaTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Costa_Rica' }));
      const hour = costaRicaTime.getHours();
      const minute = costaRicaTime.getMinutes();
      
      // Entre 4:00am y 4:05am Costa Rica
      if (hour === 4 && minute < 5) {
        const lastClear = localStorage.getItem('last_cache_clear');
        const lastClearTime = lastClear ? parseInt(lastClear) : 0;
        const hoursSinceClear = (Date.now() - lastClearTime) / (1000 * 60 * 60);
        
        if (hoursSinceClear > 12) {
          console.log('🧹 Limpiando caché programado (4am Costa Rica)');
          
          // Guardar solo datos esenciales
          const essentialData: Record<string, string> = {};
          for (let i = 0; i < 4; i++) {
            const m3u8 = localStorage.getItem(`emisor_m3u8_${i}`);
            const rtmp = localStorage.getItem(`emisor_rtmp_${i}`);
            if (m3u8) essentialData[`emisor_m3u8_${i}`] = m3u8;
            if (rtmp) essentialData[`emisor_rtmp_${i}`] = rtmp;
          }
          
          // Limpiar todo
          localStorage.clear();
          
          // Restaurar datos esenciales
          Object.entries(essentialData).forEach(([key, value]) => {
            localStorage.setItem(key, value);
          });
          
          localStorage.setItem('last_cache_clear', Date.now().toString());
          console.log('✅ Caché limpiado exitosamente');
        }
      }
    };
    
    // Verificar cada minuto
    const interval = setInterval(checkCacheClear, 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Persistir datos en localStorage cuando cambien
  useEffect(() => {
    processes.forEach((process, index) => {
      localStorage.setItem(`emisor_m3u8_${index}`, process.m3u8);
      localStorage.setItem(`emisor_rtmp_${index}`, process.rtmp);
      localStorage.setItem(`emisor_preview_suffix_${index}`, process.previewSuffix);
      localStorage.setItem(`emisor_is_emitting_${index}`, process.isEmitiendo.toString());
      localStorage.setItem(`emisor_elapsed_${index}`, process.elapsed.toString());
      localStorage.setItem(`emisor_start_time_${index}`, process.startTime.toString());
      localStorage.setItem(`emisor_status_${index}`, process.emitStatus);
      localStorage.setItem(`emisor_msg_${index}`, process.emitMsg);
      if (process.failureReason) {
        localStorage.setItem(`emisor_failure_reason_${index}`, process.failureReason);
      }
      if (process.failureDetails) {
        localStorage.setItem(`emisor_failure_details_${index}`, process.failureDetails);
      }
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

  // Ref para acceder al estado actual de processes sin causar re-renders
  const processesRef = useRef(processes);
  
  // Mantener la ref actualizada
  useEffect(() => {
    processesRef.current = processes;
  }, [processes]);

  // WebSocket para recibir notificaciones de fallo
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    const ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
      console.log('📡 Conectado al sistema de notificaciones');
    };
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        // Escuchar notificaciones de fallo
        if (data.type === 'failure') {
          const processIndex = parseInt(data.processId);
          const failureType = data.failureType; // 'source', 'rtmp', 'server'
          const details = data.details;
          
          console.log(`❌ Fallo detectado en proceso ${processIndex + 1}:`, failureType, details);
          
          const failureMessages = {
            source: '🔗 Fallo en URL Fuente',
            rtmp: '📡 Fallo en Destino RTMP',
            server: '🖥️ Fallo en Servidor'
          };
          
          // Mostrar toast de error
          toast.error(`❌ Error en Proceso ${processIndex + 1}`, {
            description: `${failureMessages[failureType as keyof typeof failureMessages] || 'Error desconocido'}: ${details}`,
          });
          
          updateProcess(processIndex, {
            failureReason: failureType,
            failureDetails: details,
            emitStatus: 'error',
            isEmitiendo: false
          });
        }
      } catch (e) {
        console.error('Error procesando mensaje WebSocket:', e);
      }
    };
    
    ws.onerror = (error) => {
      console.error('❌ Error en WebSocket:', error);
    };
    
    ws.onclose = () => {
      console.log('📡 Desconectado del sistema de notificaciones');
    };
    
    return () => {
      ws.close();
    };
  }, []);

  // Cada 5s registramos un punto de salud GLOBAL (combinando todos los procesos)
  useEffect(() => {
    const id = setInterval(() => {
      let totalUp = 0;
      let totalActive = 0;
      
      processesRef.current.forEach((process, index) => {
        const video = videoRefs[index].current;
        const up = video && video.readyState >= 2 && video.networkState !== 3 ? 1 : 0;
        
        // Solo contar procesos que están emitiendo
        if (process.isEmitiendo) {
          totalActive++;
          totalUp += up;
          
          // Lógica de reconexión simple
          if (up === 0 && process.emitStatus === 'running') {
            const now = Date.now();
            const timeSinceLastReconnect = now - process.lastReconnectTime;
            
            const maxAttempts = 5;
            const reconnectDelay = 10000; // 10 segundos entre intentos
            
            if (timeSinceLastReconnect > reconnectDelay && process.reconnectAttempts < maxAttempts) {
              console.log(`⚠️ Proceso ${index + 1}: Verificando stream... (${process.reconnectAttempts + 1}/${maxAttempts})`);
              
              updateProcess(index, {
                reconnectAttempts: process.reconnectAttempts + 1,
                lastReconnectTime: now,
                emitMsg: `Verificando conexión... (${process.reconnectAttempts + 1}/${maxAttempts})`
              });
              
              // Notificar al usuario
              if (process.reconnectAttempts === 0) {
                toast.warning(`⚠️ Proceso ${index + 1}: Señal perdida`, {
                  description: `Intentando reconectar... (1/${maxAttempts})`,
                });
              }
              
              const previewUrl = previewFromRTMP(process.rtmp, process.previewSuffix);
              if (previewUrl) {
                setTimeout(() => loadPreview(previewUrl, index), 5000);
              }
            } else if (process.reconnectAttempts >= maxAttempts) {
              const errorMsg = "Stream caído - máximo de reconexiones alcanzado";
              updateProcess(index, {
                emitMsg: errorMsg,
                emitStatus: 'error',
                failureReason: 'source',
                failureDetails: 'La señal se perdió y no pudo recuperarse automáticamente'
              });
              
              // Notificar fallo definitivo
              toast.error(`❌ Proceso ${index + 1}: Fallo de conexión`, {
                description: errorMsg,
              });
            }
          } else if (up === 1 && process.reconnectAttempts > 0) {
            console.log(`✅ Proceso ${index + 1}: Stream recuperado después de ${process.reconnectAttempts} intentos`);
            
            // Notificar recuperación exitosa
            toast.success(`✅ Proceso ${index + 1}: Señal recuperada`, {
              description: `Conexión restablecida después de ${process.reconnectAttempts} intentos`,
            });
            
            updateProcess(index, {
              reconnectAttempts: 0,
              emitMsg: process.emitStatus === 'running' ? "Emitiendo correctamente" : process.emitMsg,
              failureReason: undefined,
              failureDetails: undefined
            });
          }
        }
      });
      
      // Calcular porcentaje de uptime global (100 = todos arriba, 0 = todos caídos)
      const uptimePercentage = totalActive > 0 ? (totalUp / totalActive) * 100 : 0;
      
      setGlobalHealthPoints(prev => [
        ...prev.slice(-119),
        { t: Math.floor(Date.now() / 1000), up: uptimePercentage }
      ]);
    }, 5000);
    return () => clearInterval(id);
  }, []);

  // Función para verificar estado del proceso en el backend
  const checkProcessStatus = async (processIndex: number) => {
    try {
      const resp = await fetch(`/api/status?process_id=${processIndex}`);
      const data = await resp.json();
      
      if (!data.process_running && processes[processIndex].isEmitiendo) {
        console.error(`Proceso ${processIndex + 1}: FFmpeg no está corriendo en el servidor`);
        
        // Intentar reiniciar el proceso automáticamente
        setTimeout(() => {
          console.log(`Proceso ${processIndex + 1}: Intentando reiniciar automáticamente...`);
          startEmitToRTMP(processIndex);
        }, 5000);
      }
    } catch (e) {
      console.error(`Proceso ${processIndex + 1}: Error verificando estado del servidor`);
    }
  };

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

  async function startEmitToRTMP(processIndex: number) {
    const process = processes[processIndex];
    
    // Proceso 4 (índice 3) usa archivos locales
    if (processIndex === 3) {
      if (uploadedFiles.length === 0 || !process.rtmp) {
        updateProcess(processIndex, {
          emitStatus: "error",
          emitMsg: "Falta archivo(s) o RTMP"
        });
        return;
      }
      
      updateProcess(processIndex, {
        emitStatus: "starting",
        emitMsg: "Subiendo archivos al servidor...",
        reconnectAttempts: 0,
        lastReconnectTime: 0,
        failureReason: undefined,
        failureDetails: undefined
      });
      setUploadProgress(0);
      
      try {
        // Subir archivos al servidor con tracking de progreso usando XMLHttpRequest
        const formData = new FormData();
        uploadedFiles.forEach((file) => {
          formData.append('files', file);
        });
        formData.append('target_rtmp', process.rtmp);
        formData.append('process_id', processIndex.toString());
        
        // Usar XMLHttpRequest para poder trackear progreso
        const resp = await new Promise<any>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          
          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
              const percentComplete = Math.round((e.loaded / e.total) * 100);
              setUploadProgress(percentComplete);
              updateProcess(processIndex, {
                emitMsg: `Subiendo archivos... ${percentComplete}%`
              });
            }
          });
          
          xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                resolve(JSON.parse(xhr.responseText));
              } catch (e) {
                resolve({ success: true });
              }
            } else {
              reject(new Error(`HTTP ${xhr.status}: ${xhr.statusText}`));
            }
          });
          
          xhr.addEventListener('error', () => reject(new Error('Network error')));
          xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));
          
          xhr.open('POST', '/api/emit/files');
          xhr.send(formData);
        });
        
        setUploadProgress(100);
        const data = resp;
        
        updateProcess(processIndex, {
          emitStatus: "running",
          emitMsg: data?.message || "Emitiendo archivos a RTMP",
          elapsed: 0,
          startTime: Math.floor(Date.now() / 1000),
          isEmitiendo: true
        });
        
        // Cargar preview desde RTMP
        const previewUrl = previewFromRTMP(process.rtmp, process.previewSuffix);
        if (previewUrl) {
          setTimeout(() => {
            loadPreview(previewUrl, processIndex);
          }, 2000);
        }
      } catch (e: any) {
        const errorMsg = `No se pudo iniciar la emisión: ${e.message}`;
        
        toast.error(`❌ Error en Proceso ${processIndex + 1} (Archivos)`, {
          description: errorMsg,
        });
        
        updateProcess(processIndex, {
          emitStatus: "error",
          emitMsg: errorMsg,
          isEmitiendo: false,
          failureReason: "server",
          failureDetails: `Error al procesar archivos: ${e.message}`
        });
      }
      return;
    }
    
    // Procesos 1-3 usan M3U8
    if (!process.m3u8 || !process.rtmp) {
      updateProcess(processIndex, {
        emitStatus: "error",
        emitMsg: "Falta M3U8 o RTMP"
      });
      return;
    }
    
    updateProcess(processIndex, {
      emitStatus: "starting",
      emitMsg: "Iniciando emisión en el servidor...",
      reconnectAttempts: 0,
      lastReconnectTime: 0,
      failureReason: undefined,
      failureDetails: undefined
    });

    console.log(`🚀 Iniciando emisión ${processIndex + 1}: ${process.m3u8} → ${process.rtmp}`);

    try {
      const resp = await fetch("/api/emit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ 
          source_m3u8: process.m3u8, 
          target_rtmp: process.rtmp, 
          process_id: processIndex.toString()
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
      const errorMsg = `No se pudo iniciar la emisión: ${e.message}`;
      
      toast.error(`❌ Error en Proceso ${processIndex + 1}`, {
        description: errorMsg,
      });
      
      updateProcess(processIndex, {
        emitStatus: "error",
        emitMsg: errorMsg,
        isEmitiendo: false,
        failureReason: "server",
        failureDetails: `Error al iniciar stream M3U8: ${e.message}`
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
      emitMsg: "",
      failureReason: undefined,
      failureDetails: undefined
    });
    
    // Limpiar localStorage de emisión pero mantener datos de entrada
    localStorage.removeItem(`emisor_is_emitting_${processIndex}`);
    localStorage.removeItem(`emisor_elapsed_${processIndex}`);
    localStorage.removeItem(`emisor_start_time_${processIndex}`);
    localStorage.removeItem(`emisor_status_${processIndex}`);
    localStorage.removeItem(`emisor_msg_${processIndex}`);
    localStorage.removeItem(`emisor_failure_reason_${processIndex}`);
    localStorage.removeItem(`emisor_failure_details_${processIndex}`);
  }

  function onBorrar(processIndex: number) {
    const process = processes[processIndex];
    
    // Primero detener emisión si está activa
    if (process.isEmitiendo) {
      stopEmit(processIndex);
    }
    
    // Para el proceso 4 (archivos locales), borrar archivos del servidor
    if (processIndex === 3 && uploadedFiles.length > 0) {
      fetch('/api/emit/files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ process_id: processIndex.toString() })
      }).catch((e) => console.error('Error borrando archivos:', e));
      
      setUploadedFiles([]);
      setUploadProgress(0);
    }
    
    // Limpiar campos
    updateProcess(processIndex, {
      m3u8: "",
      rtmp: "",
      previewSuffix: "/video.m3u8"
    });
    
    // Limpiar localStorage de todos los datos
    localStorage.removeItem(`emisor_m3u8_${processIndex}`);
    localStorage.removeItem(`emisor_rtmp_${processIndex}`);
    localStorage.removeItem(`emisor_preview_suffix_${processIndex}`);
    localStorage.removeItem(`emisor_failure_reason_${processIndex}`);
    localStorage.removeItem(`emisor_failure_details_${processIndex}`);
    
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

  const getFailureIcon = (failureType?: string) => {
    switch (failureType) {
      case "source": return "🔗";
      case "rtmp": return "📡";
      case "server": return "🖥️";
      default: return "⚠️";
    }
  };

  const getFailureLabel = (failureType?: string) => {
    switch (failureType) {
      case "source": return "Fallo en URL Fuente";
      case "rtmp": return "Fallo en Destino RTMP";
      case "server": return "Fallo en Servidor";
      default: return "Error desconocido";
    }
  };

  // Función para renderizar un tab de proceso
  const renderProcessTab = (processIndex: number) => {
    const process = processes[processIndex];

    return (
      <div className="space-y-6">
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Panel de configuración */}
          <div className="bg-broadcast-panel/60 backdrop-blur-sm rounded-2xl p-5 shadow-lg border border-broadcast-border/50 transition-all duration-300 hover:shadow-xl">
            <h2 className="text-lg font-medium mb-4 text-accent">
              {processIndex === 3 ? "Archivos Locales" : "Fuente y Cabeceras"} - Proceso {processIndex + 1}
            </h2>

            {processIndex === 3 ? (
              // Proceso 4: Upload de archivos
              <>
                <label className="block text-sm mb-2 text-muted-foreground">Archivos de video (MP4, MKV, etc.)</label>
                <input
                  type="file"
                  accept="video/*"
                  multiple
                  onChange={(e) => {
                    if (e.target.files) {
                      setUploadedFiles(Array.from(e.target.files));
                    }
                  }}
                  className="w-full bg-card border border-border rounded-xl px-4 py-3 mb-2 outline-none focus:ring-2 focus:ring-primary/50 transition-all duration-200 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90"
                />
                {uploadedFiles.length > 0 && (
                  <div className="mb-4 p-3 rounded-xl bg-card/50 border border-border">
                    <p className="text-xs text-muted-foreground mb-2">Archivos seleccionados:</p>
                    <ul className="space-y-1">
                      {uploadedFiles.map((file, idx) => (
                        <li key={idx} className="text-xs text-foreground flex items-center gap-2">
                          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                          {file.name} ({(file.size / (1024 * 1024)).toFixed(2)} MB)
                        </li>
                      ))}
                    </ul>
                    {uploadProgress > 0 && uploadProgress < 100 && (
                      <div className="mt-3">
                        <div className="flex justify-between items-center mb-1">
                          <span className="text-xs text-muted-foreground">Subiendo...</span>
                          <span className="text-xs font-semibold text-primary">{uploadProgress}%</span>
                        </div>
                        <Progress value={uploadProgress} className="h-2" />
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              // Procesos 1-3: URL M3U8
              <>
                <label className="block text-sm mb-2 text-muted-foreground">URL M3U8 (fuente)</label>
                <input
                  type="url"
                  placeholder="https://servidor/origen/playlist.m3u8"
                  value={process.m3u8}
                  onChange={(e) => updateProcess(processIndex, { m3u8: e.target.value })}
                  className="w-full bg-card border border-border rounded-xl px-4 py-3 mb-4 outline-none focus:ring-2 focus:ring-primary/50 transition-all duration-200"
                />
              </>
            )}

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
              <div className={`mt-4 p-3 rounded-xl border ${
                process.emitStatus === 'error' 
                  ? 'bg-destructive/10 border-destructive/50' 
                  : process.emitStatus === 'running' 
                  ? 'bg-primary/10 border-primary/50' 
                  : 'bg-card/50 border-border'
              }`}>
                <div className="flex items-center gap-2 text-sm">
                  <span className={`inline-flex h-2.5 w-2.5 rounded-full ${getStatusColor(process.emitStatus)} ${process.emitStatus === 'running' ? 'animate-pulse' : ''}`} />
                  <span className={`${process.emitStatus === 'error' ? 'text-destructive font-semibold' : 'text-foreground'}`}>
                    {process.emitMsg}
                  </span>
                </div>
                {process.failureReason && (
                  <div className="mt-2 pl-5 text-xs text-muted-foreground">
                    Tipo: {getFailureLabel(process.failureReason)}
                  </div>
                )}
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
              {process.failureReason && (
                <div className="mt-3 p-4 rounded-xl bg-destructive/20 border-2 border-destructive shadow-lg animate-pulse">
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">{getFailureIcon(process.failureReason)}</span>
                    <div className="flex-1">
                      <p className="text-base font-bold text-destructive mb-2">
                        {getFailureLabel(process.failureReason)}
                      </p>
                      <p className="text-sm text-foreground font-medium mb-1">
                        {process.failureDetails}
                      </p>
                      <p className="text-xs text-muted-foreground mt-2">
                        La emisión se detuvo automáticamente. Revisa la configuración y vuelve a intentar.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Resumen del proceso */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="bg-broadcast-panel/60 backdrop-blur-sm rounded-2xl p-5 shadow-lg border border-broadcast-border/50 transition-all duration-300 hover:shadow-xl">
            <h3 className="text-base font-medium mb-4 text-accent">📈 Resumen - Proceso {processIndex + 1}</h3>
            <ul className="space-y-3 text-sm">
              <li className="flex justify-between">
                <span className="text-muted-foreground">Tiempo emitiendo:</span>
                <span className="font-mono text-primary font-semibold">{formatSeconds(process.elapsed)}</span>
              </li>
              <li className="flex justify-between">
                <span className="text-muted-foreground">Estado actual:</span>
                <span className={`font-semibold ${
                  process.emitStatus === 'running' ? "text-status-live" : 
                  process.emitStatus === 'error' ? "text-status-error" : 
                  "text-muted-foreground"
                }`}>
                  {process.emitStatus === 'running' ? "🟢 Emitiendo" : 
                   process.emitStatus === 'error' ? "🔴 Error" : 
                   "⚫ Detenido"}
                </span>
              </li>
              <li className="flex justify-between">
                <span className="text-muted-foreground">Reconexiones:</span>
                <span className="text-foreground font-semibold">{process.reconnectAttempts}/3</span>
              </li>
            </ul>
            {process.failureReason && (
              <div className="mt-4 p-4 rounded-xl bg-destructive/20 border-2 border-destructive shadow-lg">
                <div className="flex items-start gap-2">
                  <span className="text-xl">{getFailureIcon(process.failureReason)}</span>
                  <div className="flex-1">
                    <p className="text-sm font-bold text-destructive mb-1">
                      {getFailureLabel(process.failureReason)}
                    </p>
                    <p className="text-xs text-foreground font-medium leading-tight">
                      {process.failureDetails}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="bg-broadcast-panel/60 backdrop-blur-sm rounded-2xl p-5 shadow-lg border border-broadcast-border/50 col-span-2 transition-all duration-300 hover:shadow-xl">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-medium text-accent">📊 Monitor de Rendimiento del Servidor</h3>
              <span className="text-xs text-muted-foreground">Combinado de todos los procesos activos</span>
            </div>
            <p className="text-xs text-muted-foreground mb-2">
              {processes.filter(p => p.isEmitiendo).length > 0 
                ? `${processes.filter(p => p.isEmitiendo).length} proceso(s) activo(s) - Uptime combinado en tiempo real`
                : "Ningún proceso activo - Gráfico se actualizará cuando inicies emisión"}
            </p>
            <div className="h-48">
              {globalHealthPoints.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={globalHealthPoints.map((p) => ({
                    name: new Date(p.t * 1000).toLocaleTimeString(),
                    Uptime: p.up,
                  }))} margin={{ left: 6, right: 16, top: 10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                    <XAxis 
                      dataKey="name" 
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} 
                      interval="preserveStartEnd"
                    />
                    <YAxis 
                      domain={[0, 100]} 
                      tickFormatter={(v) => `${v}%`} 
                      width={40} 
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} 
                    />
                    <Tooltip 
                      formatter={(v) => [`${Number(v).toFixed(1)}%`, "Uptime"]} 
                      contentStyle={{ 
                        backgroundColor: "hsl(var(--card))", 
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "0.75rem",
                        color: "hsl(var(--foreground))"
                      }}
                    />
                    <Line 
                      type="monotone" 
                      dataKey="Uptime" 
                      dot={false} 
                      strokeWidth={2} 
                      stroke="hsl(var(--primary))"
                      strokeLinecap="round"
                      fill="url(#uptimeGradient)"
                    />
                    <defs>
                      <linearGradient id="uptimeGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  <span className="text-sm">📡 Esperando datos de rendimiento global...</span>
                </div>
              )}
            </div>
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
            Procesos activos: <span className="font-mono text-primary">{processes.filter(p => p.isEmitiendo).length}/4</span>
          </div>
        </header>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-4 mb-6">
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
              Archivos
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