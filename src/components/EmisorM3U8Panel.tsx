import React, { useEffect, useRef, useState, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useServerMetrics } from "@/hooks/useServerMetrics";

// ⚠️ Importante sobre User-Agent y RTMP desde el navegador:
// - No se puede cambiar el header real "User-Agent" desde JS por seguridad.
//   Usa un proxy/backend y lee el header alterno X-Requested-User-Agent.
// - El navegador NO puede "empujar" directo a RTMP. Para emitir a RTMP
//   hay que disparar un proceso en servidor (p. ej., ffmpeg) que tome la
//   fuente (m3u8) y la publique al RTMP destino. Esta UI llama endpoints
//   /api/emit (POST) y /api/emit/stop (POST) que debes implementar.

const NUM_PROCESSES = 16;
const FILE_UPLOAD_INDEX = 7; // "Subida" process
const DISNEY8_INDEX = 10; // "Disney 8" process - same as Disney 7
const FUTV_URL_INDEX = 11; // "FUTV URL" process - HLS output
const TELETICA_URL_INDEX = 13;
const TDMAS1_URL_INDEX = 14;
const CANAL6_URL_INDEX = 15;
const PUBLIC_HLS_BASE_URL = "http://167.17.69.116:3001";

// Procesos ocultos (Tigo fue descartado por restricciones del CDN/HDCP)
const HIDDEN_PROCESSES = new Set([2, 8, 9, 12]);
// Procesos que emiten HLS local (sin RTMP)
const HLS_OUTPUT_PROCESSES = new Set([FUTV_URL_INDEX, TELETICA_URL_INDEX, TDMAS1_URL_INDEX, CANAL6_URL_INDEX]);
// Índices visibles para renderizar tabs
const VISIBLE_PROCESSES = Array.from({ length: NUM_PROCESSES }, (_, i) => i).filter(i => !HIDDEN_PROCESSES.has(i));

// Tipo para un proceso de emisión
interface EmissionProcess {
  m3u8: string;
  m3u8Backup: string;
  rtmp: string;
  previewSuffix: string;
  isEmitiendo: boolean;
  elapsed: number;
  startTime: number;
  emitStatus: "idle" | "starting" | "running" | "stopping" | "stopped" | "error" | "waiting_cdn";
  emitMsg: string;
  reconnectAttempts: number;
  lastReconnectTime: number;
  failureReason?: string;
  failureDetails?: string;
  logs: LogEntry[];
  processLogsFromDB?: string;
  recoveryCount: number;
  lastSignalDuration: number;
  nightRest: boolean;
  sourceUrl?: string;
}

// Tipo para una entrada de log
interface LogEntry {
  id: string;
  timestamp: number;
  level: "info" | "success" | "warn" | "error";
  message: string;
  details?: any;
}

// Channel config for scraping
interface ChannelConfig {
  name: string;
  scrapeFn: string | null;
  channelId: string | null;
  fetchLabel: string;
  presetUrl?: string;
}

const CHANNEL_CONFIGS: ChannelConfig[] = [
  { name: "Disney 7", scrapeFn: null, channelId: null, fetchLabel: "" },
  { name: "FUTV", scrapeFn: "scrape-channel", channelId: "641cba02e4b068d89b2344e3", fetchLabel: "🔄 FUTV" },
  { name: "(oculto)", scrapeFn: null, channelId: null, fetchLabel: "" }, // 2: Tigo (descartado)
  { name: "TDmas 1", scrapeFn: "scrape-channel", channelId: "66608d188f0839b8a740cfe9", fetchLabel: "🔄 TDmas1" },
  { name: "Teletica", scrapeFn: "scrape-channel", channelId: "617c2f66e4b045a692106126", fetchLabel: "🔄 Teletica" },
  { name: "Canal 6", scrapeFn: null, channelId: null, fetchLabel: "" },
  { name: "Multimedios", scrapeFn: "scrape-channel", channelId: "664e5de58f089fa849a58697", fetchLabel: "🔄 Multi" },
  { name: "Subida", scrapeFn: null, channelId: null, fetchLabel: "" },
  { name: "(oculto)", scrapeFn: null, channelId: null, fetchLabel: "" }, // 8: Tigo (descartado)
  { name: "(oculto)", scrapeFn: null, channelId: null, fetchLabel: "" }, // 9: Tigo (descartado)
  { name: "Disney 8", scrapeFn: null, channelId: null, fetchLabel: "" },
  { name: "FUTV URL", scrapeFn: "scrape-channel", channelId: "641cba02e4b068d89b2344e3", fetchLabel: "🔄 FUTV" },
  { name: "(oculto)", scrapeFn: null, channelId: null, fetchLabel: "" }, // 12: TIGO URL (descartado, HDCP)
  { name: "TELETICA URL", scrapeFn: "scrape-channel", channelId: "617c2f66e4b045a692106126", fetchLabel: "🔄 Teletica" },
  { name: "TDMAS 1 URL", scrapeFn: "scrape-channel", channelId: "66608d188f0839b8a740cfe9", fetchLabel: "🔄 TDmas1" },
  { name: "CANAL 6 URL", scrapeFn: null, channelId: null, fetchLabel: "🏛️ Repretel", presetUrl: "https://d2qsan2ut81n2k.cloudfront.net/live/02f0dc35-8fd4-4021-8fa0-96c277f62653/ts:abr.m3u8" },
];

const defaultProcess = (): EmissionProcess => ({
  m3u8: '',
  m3u8Backup: '',
  rtmp: '',
  previewSuffix: '/video.m3u8',
  isEmitiendo: false,
  elapsed: 0,
  startTime: 0,
  emitStatus: "idle",
  emitMsg: '',
  reconnectAttempts: 0,
  lastReconnectTime: 0,
  logs: [],
  recoveryCount: 0,
  lastSignalDuration: 0,
  nightRest: false,
});

export default function EmisorM3U8Panel() {
  const logContainerRefs = Array.from({ length: NUM_PROCESSES }, () => useRef<HTMLDivElement>(null));
  
  const [activeTab, setActiveTab] = useState("0");
  const [isLoading, setIsLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  
  const [processes, setProcesses] = useState<EmissionProcess[]>(
    Array.from({ length: NUM_PROCESSES }, defaultProcess)
  );

  const timerRefs = Array.from({ length: NUM_PROCESSES }, () => useRef<ReturnType<typeof setTimeout> | null>(null));
  
  // Cargar datos desde Supabase al montar el componente
  useEffect(() => {
    const loadFromDatabase = async () => {
      try {
        const { data, error } = await supabase
          .from('emission_processes')
          .select('*')
          .order('id');
        
        if (error) throw error;
        
        if (data && data.length > 0) {
          const loadedProcesses: EmissionProcess[] = Array.from({ length: NUM_PROCESSES }, (_, index) => {
            const row = data.find(d => d.id === index);
            if (row) {
              const isRunning = row.emit_status === 'running' && row.start_time && row.start_time > 0;
              const startTimeMs = row.start_time ? row.start_time * 1000 : 0;
              let elapsedSeconds = row.elapsed || 0;

              if (isRunning && startTimeMs > 0) {
                elapsedSeconds = Math.floor((Date.now() - startTimeMs) / 1000);
              }

              // (Tigo/Evento tabs removed - indices 2, 8, 9 are hidden)
              // Solo cargar failure state si el proceso está activo
              const loadFailure = isRunning || row.is_emitting;
              return {
                m3u8: row.m3u8 || '',
                m3u8Backup: (row as any).m3u8_backup || '',
                rtmp: row.rtmp || '',
                previewSuffix: row.preview_suffix || '/video.m3u8',
                isEmitiendo: row.is_emitting || isRunning,
                elapsed: elapsedSeconds,
                startTime: startTimeMs,
                emitStatus: (row.emit_status as "idle" | "starting" | "running" | "stopping" | "error") || "idle",
                emitMsg: row.emit_msg || '',
                reconnectAttempts: 0,
                lastReconnectTime: 0,
                failureReason: loadFailure ? (row.failure_reason || undefined) : undefined,
                failureDetails: loadFailure ? (row.failure_details || undefined) : undefined,
                logs: [],
                processLogsFromDB: row.process_logs || '',
                recoveryCount: (isRunning || row.is_emitting) ? ((row as any).recovery_count || 0) : 0,
                lastSignalDuration: (row as any).last_signal_duration || 0,
                nightRest: (row as any).night_rest || false,
                sourceUrl: (row as any).source_url || '',
              };
            } else {
              return defaultProcess();
            }
          });
          setProcesses(loadedProcesses);
          
          // Crear filas faltantes en la base de datos
          for (let i = 0; i < NUM_PROCESSES; i++) {
            const exists = data.find(d => d.id === i);
            if (!exists) {
              await supabase.from('emission_processes').insert({
                id: i,
                m3u8: '',
                rtmp: '',
                preview_suffix: '/video.m3u8',
                is_emitting: false,
                elapsed: 0,
                start_time: 0,
                emit_status: 'idle',
                emit_msg: ''
              });
            }
          }
        } else {
          for (let i = 0; i < NUM_PROCESSES; i++) {
            await supabase.from('emission_processes').insert({
              id: i,
              m3u8: '',
              rtmp: '',
              preview_suffix: '/video.m3u8',
              is_emitting: false,
              elapsed: 0,
              start_time: 0,
              emit_status: 'idle',
              emit_msg: ''
            });
          }
        }
      } catch (error) {
        console.error('Error cargando procesos:', error);
        toast.error('Error al cargar procesos desde la base de datos');
      } finally {
        setIsLoading(false);
      }
    };
    
    loadFromDatabase();
    
    // Suscribirse a cambios en tiempo real
    const channel = supabase
      .channel('emission_processes_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'emission_processes'
        },
        (payload) => {
          console.log('🔄 Cambio detectado en base de datos:', payload);
          if (payload.eventType === 'UPDATE') {
            const row = payload.new as any;
            setProcesses(prev => {
              const newProcesses = [...prev];
              if (row.id >= 0 && row.id < NUM_PROCESSES) {
                const isRunning = row.emit_status === 'running' && row.start_time && row.start_time > 0;
                const startTimeMs = row.start_time ? row.start_time * 1000 : 0;
                let elapsedSeconds = row.elapsed || 0;

                if (isRunning && startTimeMs > 0) {
                  elapsedSeconds = Math.floor((Date.now() - startTimeMs) / 1000);
                }

                newProcesses[row.id] = {
                  m3u8: row.m3u8,
                  m3u8Backup: (row as any).m3u8_backup || '',
                  rtmp: row.rtmp,
                  previewSuffix: row.preview_suffix,
                  isEmitiendo: row.is_emitting || isRunning,
                  elapsed: elapsedSeconds,
                  startTime: startTimeMs,
                  emitStatus: row.emit_status,
                  emitMsg: row.emit_msg,
                  reconnectAttempts: 0,
                  lastReconnectTime: 0,
                  failureReason: row.failure_reason,
                  failureDetails: row.failure_details,
                  logs: prev[row.id]?.logs || [],
                  processLogsFromDB: row.process_logs || '',
                  recoveryCount: row.recovery_count || 0,
                  lastSignalDuration: (row as any).last_signal_duration || 0,
                  nightRest: (row as any).night_rest || false,
                  sourceUrl: (row as any).source_url || '',
                };
              }
              return newProcesses;
            });
          }
        }
      )
      .subscribe();
    
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);
  
  // Timer para actualizar elapsed cada segundo desde startTime
  useEffect(() => {
    const interval = setInterval(() => {
      setProcesses(prev => prev.map(p => {
        // Timer funciona si está emitiendo Y tiene startTime válido, sin importar si es 'starting' o 'running'
        if (p.isEmitiendo && (p.emitStatus === 'running' || p.emitStatus === 'starting') && p.startTime > 0) {
          const newElapsed = Math.floor((Date.now() - p.startTime) / 1000);
          return { ...p, elapsed: newElapsed };
        }
        return p;
      }));
    }, 1000);

    return () => clearInterval(interval);
  }, []);
  
  // Estado específico para el proceso de subida (archivos locales)
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [fetchingChannel, setFetchingChannel] = useState<number | null>(null);
  const { metricsHistory, latestMetrics } = useServerMetrics();

  // Función genérica para obtener URL de un canal automáticamente
  // Usa scraping LOCAL del VPS para que el token se genere con la IP correcta
  const fetchChannelUrl = useCallback(async (processIndex: number) => {
    const config = CHANNEL_CONFIGS[processIndex];
    if (!config.scrapeFn) return;
    
    const channelId = config.channelId;
    if (!channelId) return;
    
    setFetchingChannel(processIndex);
    try {
      // Usar scraping LOCAL del VPS (no Edge Function) para que el token
      // se genere con la misma IP que luego usa FFmpeg → evita 403
      const resp = await fetch('/api/local-scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_id: channelId, process_id: processIndex }),
      });
      const data = await resp.json();

      if (!data?.success) throw new Error(data?.error || 'Error desconocido');

      const streamUrl = data.url;
      updateProcess(processIndex, { 
        m3u8: streamUrl,
        rtmp: processesRef.current[processIndex].rtmp || ''
      });
      toast.success(`✅ URL ${config.name} extraída correctamente`);
    } catch (e: any) {
      console.error(`Error obteniendo URL ${config.name}:`, e);
      toast.error(`Error obteniendo URL ${config.name}: ${e.message}`);
    } finally {
      setFetchingChannel(null);
    }
  }, []);

  useEffect(() => {
    const canal6Preset = CHANNEL_CONFIGS[CANAL6_URL_INDEX]?.presetUrl;
    if (!canal6Preset) return;

    setProcesses(prev => {
      if (prev[CANAL6_URL_INDEX]?.m3u8 === canal6Preset) return prev;
      const next = [...prev];
      next[CANAL6_URL_INDEX] = { ...next[CANAL6_URL_INDEX], m3u8: canal6Preset };
      return next;
    });

    supabase
      .from('emission_processes')
      .update({ m3u8: canal6Preset })
      .eq('id', CANAL6_URL_INDEX)
      .then(({ error }) => {
        if (error) console.error('Error guardando URL oficial de Canal 6:', error);
      });
  }, []);



  // Función para actualizar un proceso específico
  const updateProcess = (index: number, updates: Partial<EmissionProcess>) => {
    setProcesses(prev => prev.map((process, i) => 
      i === index ? { ...process, ...updates } : process
    ));
    
    if (updates.m3u8 !== undefined || updates.rtmp !== undefined || updates.m3u8Backup !== undefined) {
      const dataToUpdate: any = {};
      if (updates.m3u8 !== undefined) dataToUpdate.m3u8 = updates.m3u8;
      if (updates.rtmp !== undefined) dataToUpdate.rtmp = updates.rtmp;
      if (updates.m3u8Backup !== undefined) dataToUpdate.m3u8_backup = updates.m3u8Backup;
      
      supabase
        .from('emission_processes')
        .update(dataToUpdate)
        .eq('id', index)
        .then(({ error }) => {
          if (error) console.error('Error actualizando proceso en DB:', error);
        });
    }
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
      }
    });
  }, []);

  // Ref para acceder al estado actual de processes sin causar re-renders
  const processesRef = useRef(processes);
  
  useEffect(() => {
    processesRef.current = processes;
  }, [processes]);

  // WebSocket para recibir logs y notificaciones en tiempo real
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    
    ws.onopen = () => {
      console.log('📡 Conectado al sistema de logs en tiempo real');
    };
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.timestamp && data.level && data.message) {
          const processIndex = parseInt(data.processId);
          if (processIndex >= 0 && processIndex < NUM_PROCESSES) {
            const logEntry: LogEntry = {
              id: data.id || `${Date.now()}-${Math.random()}`,
              timestamp: data.timestamp,
              level: data.level,
              message: data.message,
              details: data.details
            };
            
            setProcesses(prev => {
              const newProcesses = [...prev];
              newProcesses[processIndex] = {
                ...newProcesses[processIndex],
                logs: [...newProcesses[processIndex].logs, logEntry].slice(-100)
              };
              return newProcesses;
            });
            
            setTimeout(() => {
              if (logContainerRefs[processIndex]?.current) {
                logContainerRefs[processIndex].current!.scrollTop = logContainerRefs[processIndex].current!.scrollHeight;
              }
            }, 50);
          }
        }
        
        if (data.type === 'failure') {
          const processIndex = parseInt(data.processId);
          const failureType = data.failureType;
          const details = data.details;
          
          console.log(`❌ Fallo reportado en proceso ${processIndex + 1}:`, failureType, details);
          
          const failureMessages = {
            source: '🔗 Fallo en URL Fuente',
            rtmp: '📡 Fallo en Destino RTMP',
            server: '🖥️ Fallo en Servidor'
          };
          
          toast.warning(`⚠️ Advertencia en ${CHANNEL_CONFIGS[processIndex]?.name || `Proceso ${processIndex + 1}`}`, {
            description: `${failureMessages[failureType as keyof typeof failureMessages] || 'Advertencia'}: ${details}. Verificando estado...`,
          });
          
          updateProcess(processIndex, {
            failureReason: failureType,
            failureDetails: details
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
      console.log('📡 Desconectado del sistema de logs');
    };
    
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, []);

  const checkProcessStatus = async (processIndex: number) => {
    try {
      const resp = await fetch(`/api/status?process_id=${processIndex}`);
      const data = await resp.json();
      
      if (!data.process_running && processes[processIndex].isEmitiendo) {
        console.error(`${CHANNEL_CONFIGS[processIndex]?.name}: FFmpeg no está corriendo en el servidor`);
        
        setTimeout(() => {
          console.log(`${CHANNEL_CONFIGS[processIndex]?.name}: Intentando reiniciar automáticamente...`);
          startEmitToRTMP(processIndex);
        }, 5000);
      }
    } catch (e) {
      console.error(`${CHANNEL_CONFIGS[processIndex]?.name}: Error verificando estado del servidor`);
    }
  };


  const formatSeconds = (s: number) => {
    const hh = String(Math.floor(s / 3600)).padStart(2, "0");
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  };

  async function startEmitToRTMP(processIndex: number) {
    const process = processes[processIndex];
    
    // Proceso Subida (file upload)
    if (processIndex === FILE_UPLOAD_INDEX) {
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
        const formData = new FormData();
        uploadedFiles.forEach((file) => {
          formData.append('files', file);
        });
        formData.append('target_rtmp', process.rtmp);
        formData.append('process_id', processIndex.toString());
        
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
                resolve({});
              }
            } else {
              reject(new Error(`HTTP ${xhr.status}`));
            }
          });
          
          xhr.addEventListener('error', () => reject(new Error('Network error')));
          xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));
          
          xhr.open('POST', '/api/emit/files');
          xhr.send(formData);
        });
        
        setUploadProgress(100);
        
        const data = resp;
        const startTimeUnix = data.start_time || Math.floor(Date.now() / 1000);
        const startTimeMs = startTimeUnix * 1000;
        
        updateProcess(processIndex, {
          emitStatus: "running",
          emitMsg: "✅ Archivos subidos. Emisión en progreso...",
          elapsed: 0,
          startTime: startTimeMs,
          isEmitiendo: true
        });
        
        await supabase
          .from('emission_processes')
          .update({ 
            start_time: startTimeUnix,
            is_emitting: true,
            emit_status: 'running'
          })
          .eq('id', processIndex);
        
        toast.success(`${CHANNEL_CONFIGS[processIndex].name} iniciado con archivos locales`);
      } catch (e: any) {
        console.error("Error emitiendo archivos locales:", e);
        setUploadProgress(0);
        const errorMsg = e.message || "Error al subir archivos";
        updateProcess(processIndex, {
          emitStatus: "error",
          emitMsg: errorMsg,
          isEmitiendo: false,
          failureReason: "server",
          failureDetails: `Error al subir archivos: ${errorMsg}`
        });
      }
      return;
    }

    // Procesos M3U8 -> RTMP o HLS local
    const isHlsOutput = HLS_OUTPUT_PROCESSES.has(processIndex);
    if (!process.m3u8 || (!process.rtmp && !isHlsOutput)) {
      updateProcess(processIndex, {
        emitStatus: "error",
        emitMsg: isHlsOutput
          ? "Falta M3U8 (haz clic en Obtener URL)"
          : "Falta M3U8 o RTMP"
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

    try {
      const resp = await fetch("/api/emit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_m3u8: process.m3u8,
          target_rtmp: isHlsOutput ? 'hls-local' : process.rtmp,
          process_id: processIndex.toString()
        })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      
      const startTimeUnix = data.start_time || Math.floor(Date.now() / 1000);
      const startTimeMs = startTimeUnix * 1000;
      
      updateProcess(processIndex, {
        emitStatus: "running",
        emitMsg: isHlsOutput ? "✅ Emitiendo HLS" : "✅ Emitiendo a RTMP",
        elapsed: 0,
        startTime: startTimeMs,
        isEmitiendo: true
      });
      
      await supabase
        .from('emission_processes')
        .update({ 
          start_time: startTimeUnix,
          is_emitting: true,
          emit_status: 'running'
        })
        .eq('id', processIndex);
      
      toast.success(`${CHANNEL_CONFIGS[processIndex].name} iniciado`);
    } catch (e: any) {
      console.error("Error starting emit:", e);
      const errorMsg = e.message || "Error al iniciar stream";
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

    updateProcess(processIndex, {
      isEmitiendo: false,
      elapsed: 0,
      startTime: 0,
      emitStatus: "idle",
      emitMsg: "",
      failureReason: undefined,
      failureDetails: undefined,
      recoveryCount: 0,
      lastSignalDuration: 0,
    });
    
    await supabase
      .from('emission_processes')
      .update({ 
        start_time: 0,
        elapsed: 0,
        is_emitting: false,
        emit_status: 'idle',
        recovery_count: 0,
        last_signal_duration: 0,
      })
      .eq('id', processIndex);
  }


  async function onBorrar(processIndex: number) {
    const process = processes[processIndex];
    
    if (process.isEmitiendo) {
      await stopEmit(processIndex);
    }
    
    if (processIndex === FILE_UPLOAD_INDEX && uploadedFiles.length > 0) {
      fetch('/api/emit/files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ process_id: processIndex.toString() })
      }).catch((e) => console.error('Error borrando archivos:', e));
      
      setUploadedFiles([]);
      setUploadProgress(0);
    }
    
    updateProcess(processIndex, {
      m3u8: "",
      rtmp: "",
      previewSuffix: "/video.m3u8",
      isEmitiendo: false,
      elapsed: 0,
      startTime: 0,
      emitStatus: "idle",
      emitMsg: "",
      failureReason: undefined,
      failureDetails: undefined,
      recoveryCount: 0,
      lastSignalDuration: 0,
    });
    
    // Reset recovery_count and last_signal_duration in DB
    await supabase
      .from('emission_processes')
      .update({ 
        recovery_count: 0,
        last_signal_duration: 0,
        failure_reason: null,
        failure_details: null,
      })
      .eq('id', processIndex);
    
    toast.success(`${CHANNEL_CONFIGS[processIndex].name} eliminado`);
    console.log(`🧹 ${CHANNEL_CONFIGS[processIndex].name} limpiado completamente`);
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
      case "proxy_down": return "🌐";
      case "eof": return "⏹️";
      case "stall": return "🧊";
      case "cdn_unavailable": return "☁️";
      case "circuit_breaker": return "🛑";
      default: return "⚠️";
    }
  };

  const getFailureLabel = (failureType?: string) => {
    switch (failureType) {
      case "source": return "Error de Conexión con la Fuente";
      case "rtmp": return "Error de Conexión RTMP";
      case "server": return "Error del Servidor de Emisión";
      case "proxy_down": return "Proxy SOCKS5 (Pi5 CR) no responde";
      case "eof": return "Fuente cerró conexión (EOF)";
      case "stall": return "Sin frames del CDN (stall)";
      case "cdn_unavailable": return "CDN no disponible";
      case "circuit_breaker": return "Demasiadas caídas consecutivas";
      default: return "Error de Emisión";
    }
  };

  const getFailureDescription = (failureType?: string, failureDetails?: string, processIndex?: number) => {
    if (failureDetails) return failureDetails;
    const isTigo = processIndex === 12;
    switch (failureType) {
      case "source": return "No se pudo conectar con la URL de origen. Verifica que la URL sea correcta y esté accesible.";
      case "rtmp": return "No se pudo establecer conexión con el servidor RTMP. Verifica la URL RTMP y las credenciales.";
      case "server": return "El servidor de emisión encontró un problema inesperado. Intenta reiniciar la emisión.";
      case "proxy_down": return "El Pi5 (Costa Rica) no está respondiendo. Posibles causas: corte eléctrico, Wi-Fi caído, microsocks detenido, o IP residencial cambió.";
      case "eof":
        if (isTigo) return "Posibles causas: token wmsAuthSign expiró (60s), proxy SOCKS5 (Pi5 CR) tuvo microcorte, o Teletica cortó la sesión por antigüedad. Reconectando con token fresco…";
        return "El CDN cerró la conexión (token expirado, fuente terminó, o cortocircuito de red).";
      case "stall": return "El CDN dejó de enviar segmentos. Posible problema de red intermedia o caída temporal de la fuente.";
      case "cdn_unavailable": return "El CDN no respondió a las verificaciones de salud. Reintentando…";
      case "circuit_breaker": return "Demasiadas caídas seguidas. El sistema pausó los reintentos automáticos para evitar saturar la fuente. Reinicia manualmente.";
      default:
        if (isTigo) return "Error en TIGO URL. Posibles causas: proxy SOCKS5 (Pi5 CR), token expirado, Teletica cortó la sesión, o CDN inestable.";
        return "Ocurrió un error durante la emisión. Revisa la configuración e intenta nuevamente.";
    }
  };

  // Colores únicos para cada proceso
  const getProcessColor = (processIndex: number) => {
    const colors = [
      { bg: "bg-gray-500", text: "text-gray-400", stroke: "#9ca3af", name: "Disney 7" },
      { bg: "bg-blue-500", text: "text-blue-500", stroke: "#3b82f6", name: "FUTV" },
      { bg: "bg-purple-500", text: "text-purple-500", stroke: "#a855f7", name: "(oculto)" },
      { bg: "bg-green-500", text: "text-green-500", stroke: "#22c55e", name: "TDmas 1" },
      { bg: "bg-cyan-500", text: "text-cyan-500", stroke: "#06b6d4", name: "Teletica" },
      { bg: "bg-orange-500", text: "text-orange-500", stroke: "#f97316", name: "Canal 6" },
      { bg: "bg-red-500", text: "text-red-500", stroke: "#ef4444", name: "Multimedios" },
      { bg: "bg-yellow-500", text: "text-yellow-500", stroke: "#eab308", name: "Subida" },
      { bg: "bg-pink-500", text: "text-pink-500", stroke: "#ec4899", name: "(oculto)" },
      { bg: "bg-teal-500", text: "text-teal-500", stroke: "#14b8a6", name: "(oculto)" },
      { bg: "bg-indigo-500", text: "text-indigo-500", stroke: "#6366f1", name: "Disney 8" },
      { bg: "bg-emerald-500", text: "text-emerald-500", stroke: "#10b981", name: "FUTV URL" },
      { bg: "bg-sky-500", text: "text-sky-500", stroke: "#0ea5e9", name: "(oculto)" },
    ];
    return colors[processIndex];
  };

  // Función para renderizar un tab de proceso
  const renderProcessTab = (processIndex: number) => {
    const process = processes[processIndex];
    const channelConfig = CHANNEL_CONFIGS[processIndex];

    return (
      <div className="space-y-6">
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Panel de configuración */}
          <div className="bg-broadcast-panel/60 backdrop-blur-sm rounded-2xl p-5 shadow-lg border border-broadcast-border/50 transition-all duration-300 hover:shadow-xl">
            <h2 className="text-lg font-medium mb-4 text-accent">
              {processIndex === FILE_UPLOAD_INDEX ? "Archivos Locales" : "Fuente y Cabeceras"} - {channelConfig.name}
            </h2>

            {processIndex === FILE_UPLOAD_INDEX ? (
              // Proceso Subida: Upload de archivos
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
              // Procesos M3U8 normales
              <>
                <label className="block text-sm mb-2 text-muted-foreground">URL M3U8 (fuente)</label>
                <div className="flex gap-2 mb-4">
                  <input
                    type="url"
                    placeholder="https://servidor/origen/playlist.m3u8"
                    value={process.m3u8}
                    onChange={(e) => updateProcess(processIndex, { m3u8: e.target.value })}
                    className={`flex-1 bg-card border-2 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-primary/50 transition-all duration-200 ${
                      processIndex === 5 && process.isEmitiendo && process.sourceUrl && process.m3u8
                        && (process.sourceUrl === process.m3u8 || process.sourceUrl.startsWith(process.m3u8))
                        ? 'border-yellow-400 shadow-[0_0_8px_rgba(250,204,21,0.4)]'
                        : 'border-border'
                    }`}
                  />
                  {channelConfig.scrapeFn && (
                    <button
                      onClick={() => fetchChannelUrl(processIndex)}
                      disabled={fetchingChannel !== null}
                      className="px-4 py-3 rounded-xl bg-accent hover:bg-accent/90 active:scale-[.98] transition-all duration-200 font-medium text-accent-foreground shadow-lg hover:shadow-xl disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap"
                      title={`Obtener URL ${channelConfig.name} automáticamente`}
                    >
                      {fetchingChannel === processIndex ? (
                        <span className="flex items-center gap-2">
                          <span className="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-accent-foreground" />
                          Obteniendo...
                        </span>
                      ) : (
                        channelConfig.fetchLabel
                      )}
                    </button>
                  )}
                </div>
                {/* Backup URL field removed - Canal 6 now uses single URL */}
              </>
            )}
            {HLS_OUTPUT_PROCESSES.has(processIndex) ? (() => {
              const hlsSlugs: Record<number, string> = {
                [FUTV_URL_INDEX]: 'FUTV',
                [TELETICA_URL_INDEX]: 'Teletica',
                [TDMAS1_URL_INDEX]: 'Tdmas1',
                [CANAL6_URL_INDEX]: 'Canal6',
              };
              const hlsSlug = hlsSlugs[processIndex] || `stream_${processIndex}`;
              const hlsUrl = `${PUBLIC_HLS_BASE_URL}/live/${hlsSlug}/playlist.m3u8`;
              return (
              <>
                <h2 className="text-lg font-medium mb-3 text-accent">📺 URL HLS Generada</h2>
                <div className="bg-card/50 border border-border rounded-xl p-4 mb-4">
                  {process.isEmitiendo ? (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">Tu URL estable para XUI:</p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 bg-background border border-primary/30 rounded-lg px-3 py-2 text-sm font-mono text-primary break-all">
                          {hlsUrl}
                        </code>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(hlsUrl);
                            toast.success('URL copiada al portapapeles');
                          }}
                          className="px-3 py-2 rounded-lg bg-primary/20 hover:bg-primary/30 text-primary text-sm transition-all"
                        >
                          📋
                        </button>
                      </div>
                      <p className="text-xs text-muted-foreground mt-2">
                        💡 Esta URL es fija y no cambia. Agrégala directamente a XUI como source.
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      La URL se generará al iniciar la emisión. Primero obtén la señal y presiona "Emitir HLS".
                    </p>
                  )}
                </div>
              </>
              );
            })() : (
              // RTMP normal
              <>
                <h2 className="text-lg font-medium mb-3 text-accent">Destino RTMP</h2>
                <label className="block text-sm mb-2 text-muted-foreground">RTMP (app/stream)</label>
                <input
                  type="text"
                  placeholder="rtmp://fluestabiliz.giize.com/costaSTAR007"
                  value={process.rtmp}
                  onChange={(e) => updateProcess(processIndex, { rtmp: e.target.value })}
                  className="w-full bg-card border border-border rounded-xl px-4 py-3 mb-4 outline-none focus:ring-2 focus:ring-primary/50 transition-all duration-200"
                />
              </>
            )}

            <div className="flex gap-3 items-center flex-wrap">
              {!process.isEmitiendo ? (
                <button
                  onClick={() => startEmitToRTMP(processIndex)}
                  className="px-6 py-3 rounded-xl active:scale-[.98] transition-all duration-200 font-medium shadow-lg hover:shadow-xl bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  {HLS_OUTPUT_PROCESSES.has(processIndex) ? '📺 Emitir HLS' : '🚀 Emitir a RTMP'}
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

            {/* Night Rest Toggle */}
            {processIndex !== FILE_UPLOAD_INDEX && (
              <div className="flex items-center gap-3 mt-4 p-3 rounded-xl bg-card/50 border border-border">
                <Switch
                  checked={process.nightRest}
                  onCheckedChange={async (checked) => {
                    updateProcess(processIndex, { nightRest: checked });
                    try {
                      const { error } = await supabase
                        .from('emission_processes')
                        .update({ night_rest: checked } as any)
                        .eq('id', processIndex);
                      if (error) throw error;
                      toast.success(`${checked ? '🌙' : '☀️'} Descanso nocturno ${checked ? 'activado' : 'desactivado'} para ${channelConfig.name}`);
                    } catch (e) {
                      toast.error('Error al cambiar descanso nocturno');
                      updateProcess(processIndex, { nightRest: !checked });
                    }
                  }}
                />
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">🌙 Descanso nocturno</span>
                  <span className="text-xs text-muted-foreground">Apaga a la 1AM, enciende a las 5AM</span>
                </div>
              </div>
            )}

            {process.emitStatus !== "idle" && process.emitStatus !== 'error' && (
              <div className={`mt-4 p-3 rounded-xl border ${
                process.emitStatus === 'running' 
                  ? 'bg-primary/10 border-primary/50' 
                  : 'bg-card/50 border-border'
              }`}>
                <div className="flex items-center gap-2 text-sm">
                  <span className={`inline-flex h-2.5 w-2.5 rounded-full ${getStatusColor(process.emitStatus)} ${process.emitStatus === 'running' ? 'animate-pulse' : ''}`} />
                  <span className="text-foreground">{process.emitMsg}</span>
                </div>
              </div>
            )}
          </div>

          {/* Panel de Métricas */}
          <div className="bg-broadcast-panel/60 backdrop-blur-sm rounded-2xl p-6 shadow-lg border border-broadcast-border/50 transition-all duration-300 hover:shadow-xl">
            <h2 className="text-lg font-medium mb-6 text-accent">📊 Métricas - {channelConfig.name}</h2>
            
            <div className="space-y-6">
              {/* Estado Actual */}
              <div className="bg-card/50 rounded-xl p-5 border border-border">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm text-muted-foreground">Estado:</span>
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex h-3 w-3 rounded-full ${process.isEmitiendo ? "bg-status-live" : "bg-status-idle"} ${process.isEmitiendo ? 'animate-pulse' : ''}`}></span>
                    <span className="font-semibold text-lg">{process.isEmitiendo ? "🔴 Activo" : "⚫ Inactivo"}</span>
                  </div>
                </div>
                
                {process.emitStatus !== 'idle' && (
                  <div className="mt-2 pt-3 border-t border-border/50">
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex h-2 w-2 rounded-full ${getStatusColor(process.emitStatus)}`} />
                      <span className="text-xs text-muted-foreground">{process.emitMsg}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Tiempo Activo */}
              <div className="bg-card/50 rounded-xl p-5 border border-border">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-muted-foreground">⏱️ Tiempo Activo:</span>
                  <span className="font-mono text-3xl font-bold text-primary">{formatSeconds(process.elapsed)}</span>
                </div>
                
                {process.isEmitiendo && process.startTime > 0 && (
                  <div className="mt-3 pt-3 border-t border-border/50">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Inicio:</span>
                      <span className="text-foreground">{new Date(process.startTime).toLocaleString('es-CR', { 
                        dateStyle: 'short', 
                        timeStyle: 'medium' 
                      })}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Contador de Reinicios / Cambios de URL */}
              <div className="bg-card/50 rounded-xl p-5 border border-border">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">🔄 Reinicios / Cambios URL:</span>
                  <span className={`font-mono text-2xl font-bold ${process.recoveryCount > 0 ? 'text-warning' : 'text-muted-foreground'}`}>
                    {process.recoveryCount}
                  </span>
                </div>
                {process.lastSignalDuration > 0 && (
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-border">
                    <span className="text-sm text-muted-foreground">⏱️ Última señal duró:</span>
                    <span className="font-mono text-sm font-semibold text-foreground">
                      {(() => {
                        const d = process.lastSignalDuration;
                        const h = Math.floor(d / 3600);
                        const m = Math.floor((d % 3600) / 60);
                        const s = d % 60;
                        if (h > 0) return `${h}h ${m}m ${s}s`;
                        if (m > 0) return `${m}m ${s}s`;
                        return `${s}s`;
                      })()}
                    </span>
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-1">Veces que se ha reiniciado o cambiado la URL automáticamente</p>
              </div>

              {/* Duración de emisión (si hay caída) */}
              {!process.isEmitiendo && process.elapsed > 0 && (
                <div className="bg-warning/10 rounded-xl p-5 border border-warning/30">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-warning text-lg">⚠️</span>
                    <span className="text-sm font-medium text-warning">Última Emisión Detenida</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Duró:</span>
                    <span className="font-mono text-xl font-semibold text-warning">{formatSeconds(process.elapsed)}</span>
                  </div>
                  
                  {process.failureReason && (
                    <div className="mt-3 pt-3 border-t border-warning/20">
                      <div className="flex items-start gap-2">
                        <span className="text-xs">{getFailureIcon(process.failureReason)}</span>
                        <div className="flex-1">
                          <p className="text-xs font-medium text-warning mb-1">{getFailureLabel(process.failureReason)}</p>
                          <p className="text-xs text-muted-foreground">{getFailureDescription(process.failureReason, process.failureDetails, processIndex)}</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Error activo */}
              {process.emitStatus === 'error' && process.failureReason && (
                <div className="bg-destructive/10 rounded-xl p-5 border border-destructive/30">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-destructive text-lg">{getFailureIcon(process.failureReason)}</span>
                    <span className="text-sm font-medium text-destructive">{getFailureLabel(process.failureReason)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{getFailureDescription(process.failureReason, process.failureDetails, processIndex)}</p>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Panel de Logs en Tiempo Real */}
        <section className="bg-broadcast-panel/60 backdrop-blur-sm rounded-2xl p-5 shadow-lg border border-broadcast-border/50">
          <h3 className="text-lg font-medium mb-3 text-accent">📋 Logs en Tiempo Real</h3>
          
          <div 
            ref={logContainerRefs[processIndex]}
            className="bg-card/50 border border-border rounded-xl p-4 h-64 overflow-y-auto font-mono text-xs space-y-1 scroll-smooth"
          >
            {/* Logs guardados en DB */}
            {process.processLogsFromDB && process.processLogsFromDB.trim() && (
              <>
                {process.processLogsFromDB.split('\n').filter(line => line.trim()).map((line, idx) => {
                  const isError = line.includes('Error') || line.includes('error') || line.includes('❌');
                  const isSuccess = line.includes('exitosamente') || line.includes('✅') || line.includes('✓');
                  const isWarning = line.includes('warn') || line.includes('⚠️');
                  
                  return (
                    <div 
                      key={`db-${idx}`} 
                      className={`p-2 rounded ${
                        isError ? 'bg-destructive/10 text-destructive' :
                        isSuccess ? 'bg-success/10 text-success' :
                        isWarning ? 'bg-warning/10 text-warning' :
                        'text-muted-foreground'
                      }`}
                    >
                      {line}
                    </div>
                  );
                })}
                {process.logs.length > 0 && <div className="border-t border-border my-2" />}
              </>
            )}
            
            {/* Logs en tiempo real */}
            {process.logs.map((log) => (
              <div 
                key={log.id} 
                className={`p-2 rounded ${
                  log.level === 'error' ? 'bg-destructive/10 text-destructive' :
                  log.level === 'success' ? 'bg-success/10 text-success' :
                  log.level === 'warn' ? 'bg-warning/10 text-warning' :
                  'text-muted-foreground'
                }`}
              >
                <span className="opacity-70">{new Date(log.timestamp).toLocaleTimeString('es-CR')}</span>
                {' '}
                <span className="font-semibold">[{log.level.toUpperCase()}]</span>
                {' '}
                {log.message}
                {log.details && (
                  <div className="mt-1 ml-4 text-xs opacity-80">
                    {JSON.stringify(log.details, null, 2)}
                  </div>
                )}
              </div>
            ))}
            
            {process.logs.length === 0 && !process.processLogsFromDB && (
              <div className="text-muted-foreground text-center py-8">
                No hay logs disponibles. Los logs aparecerán cuando el proceso esté activo.
              </div>
            )}
          </div>
        </section>
      </div>
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-background via-background to-muted/30">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-primary mb-4" />
          <p className="text-muted-foreground">Cargando procesos...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/30 p-6">
      <div className="max-w-[1800px] mx-auto">
        <header className="mb-8 text-center">
          <h1 className="text-4xl font-bold mb-2 bg-gradient-to-r from-primary via-accent to-primary bg-clip-text text-transparent animate-gradient">
            📡 Sistema de Emisión M3U8 a RTMP
          </h1>
          <p className="text-muted-foreground">
            Gestiona hasta {VISIBLE_PROCESSES.length} procesos de streaming simultáneos
          </p>
        </header>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <div className="mb-6 px-1 overflow-x-auto scrollbar-hide md:flex md:justify-center">
            <TabsList className="bg-card/60 backdrop-blur-sm p-1.5 rounded-2xl shadow-lg border border-border inline-flex flex-nowrap gap-1 min-w-max md:flex-wrap md:min-w-0">
              {VISIBLE_PROCESSES.map((i) => {
                const color = getProcessColor(i);
                const process = processes[i];
                return (
                  <TabsTrigger 
                    key={i} 
                    value={i.toString()}
                    className={`px-3 py-2 sm:px-4 sm:py-2.5 rounded-xl transition-all duration-200 relative flex-shrink-0 ${
                      process.isEmitiendo 
                        ? 'bg-green-500/20 border-2 border-green-500 text-green-400 shadow-lg shadow-green-500/50 hover:bg-green-500/30' 
                        : activeTab === i.toString() 
                          ? `${color.bg} text-white shadow-lg` 
                          : 'hover:bg-muted/50'
                    }`}
                  >
                    <span className="relative flex items-center justify-center gap-1 sm:gap-1.5 text-xs sm:text-sm whitespace-nowrap">
                      {process.isEmitiendo && (
                        <span className="inline-flex h-1.5 w-1.5 sm:h-2 sm:w-2 rounded-full bg-green-500 animate-pulse"></span>
                      )}
                      {color.name}
                    </span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>

          {VISIBLE_PROCESSES.map((i) => (
            <TabsContent key={i} value={i.toString()}>
              {renderProcessTab(i)}
            </TabsContent>
          ))}
        </Tabs>

        {/* Panel de Métricas del Servidor */}
        <section className="mt-8 bg-broadcast-panel/60 backdrop-blur-sm rounded-2xl p-6 shadow-lg border border-broadcast-border/50">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold text-accent">🖥️ Métricas del Servidor</h2>
            {latestMetrics && (
              <div className="flex gap-4 text-xs text-muted-foreground">
                <span>Cores: {latestMetrics.cpu.cores}</span>
                <span>RAM Total: {(latestMetrics.memory.total / 1024).toFixed(1)} GB</span>
                <span>Uptime: {Math.floor(latestMetrics.uptime / 3600)}h {Math.floor((latestMetrics.uptime % 3600) / 60)}m</span>
              </div>
            )}
          </div>

          {metricsHistory.length < 2 ? (
            <div className="text-muted-foreground text-center py-12">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary mb-3" />
              <p>Recopilando métricas del servidor...</p>
              <p className="text-xs mt-1">Las gráficas aparecerán en unos segundos</p>
            </div>
          ) : (
            <>
              {/* Indicadores actuales */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <div className="bg-card/50 rounded-xl p-4 border border-border">
                  <p className="text-xs text-muted-foreground mb-1">CPU</p>
                  <p className={`text-2xl font-bold font-mono ${
                    (latestMetrics?.cpu.usage || 0) > 80 ? 'text-destructive' : 
                    (latestMetrics?.cpu.usage || 0) > 50 ? 'text-warning' : 'text-primary'
                  }`}>
                    {latestMetrics?.cpu.usage?.toFixed(1) || '0.0'}%
                  </p>
                </div>
                <div className="bg-card/50 rounded-xl p-4 border border-border">
                  <p className="text-xs text-muted-foreground mb-1">RAM</p>
                  <p className={`text-2xl font-bold font-mono ${
                    (latestMetrics?.memory.percent || 0) > 85 ? 'text-destructive' : 
                    (latestMetrics?.memory.percent || 0) > 60 ? 'text-warning' : 'text-primary'
                  }`}>
                    {latestMetrics?.memory.percent?.toFixed(1) || '0.0'}%
                  </p>
                  <p className="text-xs text-muted-foreground">{latestMetrics?.memory.used || 0} / {latestMetrics?.memory.total || 0} MB</p>
                </div>
                <div className="bg-card/50 rounded-xl p-4 border border-border">
                  <p className="text-xs text-muted-foreground mb-1">↓ Red (Rx)</p>
                  <p className="text-2xl font-bold font-mono text-primary">
                    {latestMetrics?.network.rxMbps?.toFixed(2) || '0.00'}
                  </p>
                  <p className="text-xs text-muted-foreground">MB/s</p>
                </div>
                <div className="bg-card/50 rounded-xl p-4 border border-border">
                  <p className="text-xs text-muted-foreground mb-1">↑ Red (Tx)</p>
                  <p className="text-2xl font-bold font-mono text-primary">
                    {latestMetrics?.network.txMbps?.toFixed(2) || '0.00'}
                  </p>
                  <p className="text-xs text-muted-foreground">MB/s</p>
                </div>
              </div>

              {/* Gráficas */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* CPU */}
                <div className="bg-card/50 rounded-xl p-4 border border-border">
                  <h3 className="text-sm font-medium text-muted-foreground mb-3">📈 CPU (%)</h3>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={metricsHistory}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="time" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" interval="preserveStartEnd" />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                      <Tooltip 
                        contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontSize: '12px' }}
                        labelStyle={{ color: 'hsl(var(--foreground))' }}
                      />
                      <Line type="monotone" dataKey="cpu" stroke="#3b82f6" strokeWidth={2} dot={false} name="CPU %" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                {/* RAM */}
                <div className="bg-card/50 rounded-xl p-4 border border-border">
                  <h3 className="text-sm font-medium text-muted-foreground mb-3">💾 RAM (%)</h3>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={metricsHistory}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="time" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" interval="preserveStartEnd" />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                      <Tooltip 
                        contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontSize: '12px' }}
                        labelStyle={{ color: 'hsl(var(--foreground))' }}
                      />
                      <Line type="monotone" dataKey="ramPercent" stroke="#a855f7" strokeWidth={2} dot={false} name="RAM %" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                {/* Red */}
                <div className="bg-card/50 rounded-xl p-4 border border-border">
                  <h3 className="text-sm font-medium text-muted-foreground mb-3">🌐 Red (MB/s)</h3>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={metricsHistory}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="time" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                      <Tooltip 
                        contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontSize: '12px' }}
                        labelStyle={{ color: 'hsl(var(--foreground))' }}
                      />
                      <Line type="monotone" dataKey="rxMbps" stroke="#22c55e" strokeWidth={2} dot={false} name="↓ Rx MB/s" />
                      <Line type="monotone" dataKey="txMbps" stroke="#f97316" strokeWidth={2} dot={false} name="↑ Tx MB/s" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
