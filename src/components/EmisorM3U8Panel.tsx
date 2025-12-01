import React, { useEffect, useRef, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

// ⚠️ Importante sobre User-Agent y RTMP desde el navegador:
// - No se puede cambiar el header real "User-Agent" desde JS por seguridad.
//   Usa un proxy/backend y lee el header alterno X-Requested-User-Agent.
// - El navegador NO puede "empujar" directo a RTMP. Para emitir a RTMP
//   hay que disparar un proceso en servidor (p. ej., ffmpeg) que tome la
//   fuente (m3u8) y la publique al RTMP destino. Esta UI llama endpoints
//   /api/emit (POST) y /api/emit/stop (POST) que debes implementar.

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
  logs: LogEntry[]; // Logs en tiempo real
  processLogsFromDB?: string; // Logs guardados en DB
}

// Tipo para una entrada de log
interface LogEntry {
  id: string;
  timestamp: number;
  level: "info" | "success" | "warn" | "error";
  message: string;
  details?: any;
}

export default function EmisorM3U8Panel() {
  const logContainerRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  
  const [activeTab, setActiveTab] = useState("0");
  const [isLoading, setIsLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  
  // Estado para 4 procesos independientes - ahora carga desde Supabase
  const [processes, setProcesses] = useState<EmissionProcess[]>([
    {
      m3u8: "",
      rtmp: "",
      previewSuffix: "/video.m3u8",
      isEmitiendo: false,
      elapsed: 0,
      startTime: 0,
      emitStatus: "idle",
      emitMsg: "",
      reconnectAttempts: 0,
      lastReconnectTime: 0,
      logs: []
    },
    {
      m3u8: "",
      rtmp: "",
      previewSuffix: "/video.m3u8",
      isEmitiendo: false,
      elapsed: 0,
      startTime: 0,
      emitStatus: "idle",
      emitMsg: "",
      reconnectAttempts: 0,
      lastReconnectTime: 0,
      logs: []
    },
    {
      m3u8: "",
      rtmp: "",
      previewSuffix: "/video.m3u8",
      isEmitiendo: false,
      elapsed: 0,
      startTime: 0,
      emitStatus: "idle",
      emitMsg: "",
      reconnectAttempts: 0,
      lastReconnectTime: 0,
      logs: []
    },
    {
      m3u8: "",
      rtmp: "",
      previewSuffix: "/video.m3u8",
      isEmitiendo: false,
      elapsed: 0,
      startTime: 0,
      emitStatus: "idle",
      emitMsg: "",
      reconnectAttempts: 0,
      lastReconnectTime: 0,
      logs: []
    }
  ]);

  const timerRefs = [useRef<NodeJS.Timeout | null>(null), useRef<NodeJS.Timeout | null>(null), useRef<NodeJS.Timeout | null>(null), useRef<NodeJS.Timeout | null>(null)];
  
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
          // Asegurar que siempre tengamos 4 procesos
          const loadedProcesses: EmissionProcess[] = [0, 1, 2, 3].map(index => {
            const row = data.find(d => d.id === index);
            if (row) {
              const isRunning = row.emit_status === 'running' && row.start_time && row.start_time > 0;
              const startTimeMs = row.start_time ? row.start_time * 1000 : 0;
              let elapsedSeconds = row.elapsed || 0;

              // Si el proceso está corriendo, recalcular el tiempo activo desde start_time
              if (isRunning && startTimeMs > 0) {
                elapsedSeconds = Math.floor((Date.now() - startTimeMs) / 1000);
              }

              return {
                m3u8: row.m3u8 || '',
                rtmp: row.rtmp || '',
                previewSuffix: row.preview_suffix || '/video.m3u8',
                isEmitiendo: row.is_emitting || isRunning,
                elapsed: elapsedSeconds,
                startTime: startTimeMs,
                emitStatus: (row.emit_status as "idle" | "starting" | "running" | "stopping" | "error") || "idle",
                emitMsg: row.emit_msg || '',
                reconnectAttempts: 0,
                lastReconnectTime: 0,
                failureReason: row.failure_reason || undefined,
                failureDetails: row.failure_details || undefined,
                logs: [],
                processLogsFromDB: row.process_logs || ''
              };
            } else {
              // Si no existe, mantener valores por defecto pero crear en DB
              return {
                m3u8: '',
                rtmp: '',
                previewSuffix: '/video.m3u8',
                isEmitiendo: false,
                elapsed: 0,
                startTime: 0,
                emitStatus: "idle" as const,
                emitMsg: '',
                reconnectAttempts: 0,
                lastReconnectTime: 0,
                logs: []
              };
            }
          });
          setProcesses(loadedProcesses);
          
          // Crear filas faltantes en la base de datos
          for (let i = 0; i < 4; i++) {
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
          // Si no hay datos, crear las 4 filas iniciales
          for (let i = 0; i < 4; i++) {
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
              if (row.id >= 0 && row.id <= 3) {
                const isRunning = row.emit_status === 'running' && row.start_time && row.start_time > 0;
                const startTimeMs = row.start_time ? row.start_time * 1000 : 0;
                let elapsedSeconds = row.elapsed || 0;

                // Si el proceso está corriendo, recalcular el tiempo activo desde start_time
                if (isRunning && startTimeMs > 0) {
                  elapsedSeconds = Math.floor((Date.now() - startTimeMs) / 1000);
                }

                newProcesses[row.id] = {
                  m3u8: row.m3u8,
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
                  processLogsFromDB: row.process_logs || ''
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
        if (p.isEmitiendo && p.emitStatus === 'running' && p.startTime > 0) {
          const newElapsed = Math.floor((Date.now() - p.startTime) / 1000);
          return { ...p, elapsed: newElapsed };
        }
        return p;
      }));
    }, 1000);

    return () => clearInterval(interval);
  }, []);
  
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
    
    // Si se actualizan m3u8 o rtmp, guardar automáticamente en Supabase
    if (updates.m3u8 !== undefined || updates.rtmp !== undefined) {
      const dataToUpdate: any = {};
      if (updates.m3u8 !== undefined) dataToUpdate.m3u8 = updates.m3u8;
      if (updates.rtmp !== undefined) dataToUpdate.rtmp = updates.rtmp;
      
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
  
  // Mantener la ref actualizada
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
        
        // Capturar logs en tiempo real
        if (data.timestamp && data.level && data.message) {
          const processIndex = parseInt(data.processId);
          if (processIndex >= 0 && processIndex <= 3) {
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
                logs: [...newProcesses[processIndex].logs, logEntry].slice(-100) // Mantener últimos 100 logs
              };
              return newProcesses;
            });
            
            // Scroll automático al final
            setTimeout(() => {
              if (logContainerRefs[processIndex].current) {
                logContainerRefs[processIndex].current!.scrollTop = logContainerRefs[processIndex].current!.scrollHeight;
              }
            }, 50);
          }
        }
        
        // Escuchar notificaciones de fallo
        if (data.type === 'failure') {
          const processIndex = parseInt(data.processId);
          const failureType = data.failureType; // 'source', 'rtmp', 'server'
          const details = data.details;
          
          console.log(`❌ Fallo reportado en proceso ${processIndex + 1}:`, failureType, details);
          
          const failureMessages = {
            source: '🔗 Fallo en URL Fuente',
            rtmp: '📡 Fallo en Destino RTMP',
            server: '🖥️ Fallo en Servidor'
          };
          
          // Mostrar toast de advertencia
          toast.warning(`⚠️ Advertencia en Proceso ${processIndex + 1}`, {
            description: `${failureMessages[failureType as keyof typeof failureMessages] || 'Advertencia'}: ${details}. Verificando estado...`,
          });
          
          // Marcar advertencia pero no detener inmediatamente
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
            // Usar función de actualización para obtener el valor más reciente
            setProcesses(prev => prev.map((p, i) => 
              i === index ? { ...p, elapsed: p.elapsed + 1 } : p
            ));
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
  }, [processes.map(p => p.isEmitiendo).join(',')]);

  const formatSeconds = (s: number) => {
    const hh = String(Math.floor(s / 3600)).padStart(2, "0");
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  };

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
        const startTimeMs = startTimeUnix * 1000; // Convertir a milisegundos para consistencia
        
        updateProcess(processIndex, {
          emitStatus: "running",
          emitMsg: "✅ Archivos subidos. Emisión en progreso...",
          elapsed: 0,
          startTime: startTimeMs,
          isEmitiendo: true
        });
        
        // Guardar start_time en Supabase igual que m3u8 y rtmp
        await supabase
          .from('emission_processes')
          .update({ 
            start_time: startTimeUnix,
            is_emitting: true,
            emit_status: 'running'
          })
          .eq('id', processIndex);
        
        toast.success(`Proceso ${processIndex + 1} iniciado con archivos locales`);
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

    // Procesos 1-3: M3U8 -> RTMP
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

    try {
      const resp = await fetch("/api/emit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_m3u8: process.m3u8,
          target_rtmp: process.rtmp,
          process_id: processIndex.toString()
        })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      
      const startTimeUnix = data.start_time || Math.floor(Date.now() / 1000);
      const startTimeMs = startTimeUnix * 1000; // Convertir a milisegundos para consistencia
      
      updateProcess(processIndex, {
        emitStatus: "running",
        emitMsg: "✅ Emitiendo a RTMP",
        elapsed: 0,
        startTime: startTimeMs,
        isEmitiendo: true
      });
      
      // Guardar start_time en Supabase igual que m3u8 y rtmp
      await supabase
        .from('emission_processes')
        .update({ 
          start_time: startTimeUnix,
          is_emitting: true,
          emit_status: 'running'
        })
        .eq('id', processIndex);
      
      toast.success(`Proceso ${processIndex + 1} iniciado`);
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
      failureDetails: undefined
    });
    
    // Guardar el reset en Supabase igual que m3u8 y rtmp
    await supabase
      .from('emission_processes')
      .update({ 
        start_time: 0,
        elapsed: 0,
        is_emitting: false,
        emit_status: 'idle'
      })
      .eq('id', processIndex);
    
    // Limpiar localStorage de emisión pero mantener datos de entrada
    localStorage.removeItem(`emisor_is_emitting_${processIndex}`);
    localStorage.removeItem(`emisor_elapsed_${processIndex}`);
    localStorage.removeItem(`emisor_start_time_${processIndex}`);
    localStorage.removeItem(`emisor_status_${processIndex}`);
    localStorage.removeItem(`emisor_msg_${processIndex}`);
    localStorage.removeItem(`emisor_failure_reason_${processIndex}`);
    localStorage.removeItem(`emisor_failure_details_${processIndex}`);
  }

  async function onBorrar(processIndex: number) {
    const process = processes[processIndex];
    
    // Primero detener emisión si está activa
    if (process.isEmitiendo) {
      await stopEmit(processIndex);
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
      previewSuffix: "/video.m3u8",
      isEmitiendo: false,
      elapsed: 0,
      startTime: 0,
      emitStatus: "idle",
      emitMsg: "",
      failureReason: undefined,
      failureDetails: undefined
    });
    
    toast.success(`Proceso ${processIndex + 1} eliminado`);
    console.log(`🧹 Proceso ${processIndex + 1} limpiado completamente, listo para nueva configuración`);
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
      case "source": return "Error de Conexión con la Fuente";
      case "rtmp": return "Error de Conexión RTMP";
      case "server": return "Error del Servidor de Emisión";
      default: return "Error de Emisión";
    }
  };

  const getFailureDescription = (failureType?: string, failureDetails?: string) => {
    if (failureDetails) return failureDetails;
    
    switch (failureType) {
      case "source": return "No se pudo conectar con la URL de origen. Verifica que la URL sea correcta y esté accesible.";
      case "rtmp": return "No se pudo establecer conexión con el servidor RTMP. Verifica la URL RTMP y las credenciales.";
      case "server": return "El servidor de emisión encontró un problema inesperado. Intenta reiniciar la emisión.";
      default: return "Ocurrió un error durante la emisión. Revisa la configuración e intenta nuevamente.";
    }
  };

  // Colores únicos para cada proceso
  const getProcessColor = (processIndex: number) => {
    const colors = [
      { bg: "bg-blue-500", text: "text-blue-500", stroke: "#3b82f6", name: "Proceso 1" },
      { bg: "bg-purple-500", text: "text-purple-500", stroke: "#a855f7", name: "Proceso 2" },
      { bg: "bg-green-500", text: "text-green-500", stroke: "#22c55e", name: "Proceso 3" },
      { bg: "bg-yellow-500", text: "text-yellow-500", stroke: "#eab308", name: "Proceso 4" }
    ];
    return colors[processIndex];
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
              className="w-full bg-card border border-border rounded-xl px-4 py-3 mb-4 outline-none focus:ring-2 focus:ring-primary/50 transition-all duration-200"
            />

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
            <h2 className="text-lg font-medium mb-6 text-accent">📊 Métricas - Proceso {processIndex + 1}</h2>
            
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
                          <p className="text-xs text-muted-foreground">{getFailureDescription(process.failureReason, process.failureDetails)}</p>
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
                  <p className="text-xs text-muted-foreground">{getFailureDescription(process.failureReason, process.failureDetails)}</p>
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
            Gestiona hasta 4 procesos de streaming simultáneos
          </p>
        </header>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <div className="mb-6 flex justify-center">
            <TabsList className="bg-card/60 backdrop-blur-sm p-1.5 rounded-2xl shadow-lg border border-border">
              {[0, 1, 2, 3].map((i) => {
                const color = getProcessColor(i);
                const process = processes[i];
                return (
                  <TabsTrigger 
                    key={i} 
                    value={i.toString()}
                    className={`px-6 py-3 rounded-xl transition-all duration-200 relative ${
                      process.isEmitiendo 
                        ? 'bg-green-500/20 border-2 border-green-500 text-green-400 shadow-lg shadow-green-500/50 hover:bg-green-500/30' 
                        : activeTab === i.toString() 
                          ? `${color.bg} text-white shadow-lg` 
                          : 'hover:bg-muted/50'
                    }`}
                  >
                    <span className="relative flex items-center gap-2">
                      {process.isEmitiendo && (
                        <span className="inline-flex h-2.5 w-2.5 rounded-full bg-green-500 animate-pulse mr-1"></span>
                      )}
                      {color.name}
                    </span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </div>

          {[0, 1, 2, 3].map((i) => (
            <TabsContent key={i} value={i.toString()}>
              {renderProcessTab(i)}
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </div>
  );
}
