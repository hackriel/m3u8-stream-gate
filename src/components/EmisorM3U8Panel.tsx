import React, { useEffect, useRef, useState, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesUpdate } from "@/integrations/supabase/types";
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

type EmissionRow = Tables<"emission_processes">;
type EmissionRowUpdate = TablesUpdate<"emission_processes">;
type EmitStatus = EmissionProcess["emitStatus"];

type UploadEmitResponse = {
  start_time?: number;
};

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
};

const toEmitStatus = (status: string | null | undefined): EmitStatus => {
  if (
    status === "idle" ||
    status === "starting" ||
    status === "running" ||
    status === "stopping" ||
    status === "stopped" ||
    status === "error" ||
    status === "waiting_cdn"
  ) {
    return status;
  }

  return "idle";
};

const rowToProcess = (row: EmissionRow, previousLogs: LogEntry[] = []): EmissionProcess => {
  const isRunning = row.emit_status === "running" && row.start_time > 0;
  const startTimeMs = row.start_time ? row.start_time * 1000 : 0;
  const elapsed = isRunning && startTimeMs > 0
    ? Math.floor((Date.now() - startTimeMs) / 1000)
    : row.elapsed || 0;
  const loadFailure = isRunning || row.is_emitting;

  return {
    m3u8: row.m3u8 || "",
    m3u8Backup: row.m3u8_backup || "",
    rtmp: row.rtmp || "",
    previewSuffix: row.preview_suffix || "/video.m3u8",
    isEmitiendo: row.is_emitting || isRunning,
    elapsed,
    startTime: startTimeMs,
    emitStatus: toEmitStatus(row.emit_status),
    emitMsg: row.emit_msg || "",
    reconnectAttempts: 0,
    lastReconnectTime: 0,
    failureReason: loadFailure ? row.failure_reason || undefined : undefined,
    failureDetails: loadFailure ? row.failure_details || undefined : undefined,
    logs: previousLogs,
    processLogsFromDB: row.process_logs || "",
    recoveryCount: (isRunning || row.is_emitting) ? (row.recovery_count || 0) : 0,
    lastSignalDuration: row.last_signal_duration || 0,
    nightRest: row.night_rest || false,
    sourceUrl: row.source_url || "",
  };
};

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
  details?: unknown;
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
  { name: "(oculto)", scrapeFn: null, channelId: null, fetchLabel: "" },
  { name: "TDmas 1", scrapeFn: "scrape-channel", channelId: "66608d188f0839b8a740cfe9", fetchLabel: "🔄 TDmas1" },
  { name: "Teletica", scrapeFn: "scrape-channel", channelId: "617c2f66e4b045a692106126", fetchLabel: "🔄 Teletica" },
  { name: "Canal 6", scrapeFn: null, channelId: null, fetchLabel: "" },
  { name: "Multimedios", scrapeFn: "scrape-channel", channelId: "664e5de58f089fa849a58697", fetchLabel: "🔄 Multi" },
  { name: "Subida", scrapeFn: null, channelId: null, fetchLabel: "" },
  { name: "(oculto)", scrapeFn: null, channelId: null, fetchLabel: "" },
  { name: "(oculto)", scrapeFn: null, channelId: null, fetchLabel: "" },
  { name: "Disney 8", scrapeFn: null, channelId: null, fetchLabel: "" },
  { name: "FUTV URL", scrapeFn: "scrape-channel", channelId: "641cba02e4b068d89b2344e3", fetchLabel: "🔄 FUTV" },
  { name: "(oculto)", scrapeFn: null, channelId: null, fetchLabel: "" },
  { name: "TELETICA URL", scrapeFn: "scrape-channel", channelId: "617c2f66e4b045a692106126", fetchLabel: "🔄 Teletica" },
  { name: "TDMAS 1 URL", scrapeFn: "scrape-channel", channelId: "66608d188f0839b8a740cfe9", fetchLabel: "🔄 TDmas1" },
  { name: "CANAL 6 URL", scrapeFn: null, channelId: null, fetchLabel: "🏛️ Repretel", presetUrl: "https://d2qsan2ut81n2k.cloudfront.net/live/02f0dc35-8fd4-4021-8fa0-96c277f62653/ts:abr.m3u8" },
];

const defaultProcess = (): EmissionProcess => ({
  m3u8: "",
  m3u8Backup: "",
  rtmp: "",
  previewSuffix: "/video.m3u8",
  isEmitiendo: false,
  elapsed: 0,
  startTime: 0,
  emitStatus: "idle",
  emitMsg: "",
  reconnectAttempts: 0,
  lastReconnectTime: 0,
  logs: [],
  recoveryCount: 0,
  lastSignalDuration: 0,
  nightRest: false,
});

export default function EmisorM3U8Panel() {
  const logContainerRefs = useRef<Array<HTMLDivElement | null>>([]);
  const restoredSessionsRef = useRef(false);
  const [activeTab, setActiveTab] = useState("0");
  const [isLoading, setIsLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const [processes, setProcesses] = useState<EmissionProcess[]>(Array.from({ length: NUM_PROCESSES }, defaultProcess));
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [fetchingChannel, setFetchingChannel] = useState<number | null>(null);
  const { metricsHistory, latestMetrics } = useServerMetrics();
  const processesRef = useRef(processes);

  useEffect(() => {
    processesRef.current = processes;
  }, [processes]);

  const updateProcess = useCallback((index: number, updates: Partial<EmissionProcess>) => {
    setProcesses((prev) => prev.map((process, i) => (i === index ? { ...process, ...updates } : process)));

    if (updates.m3u8 !== undefined || updates.rtmp !== undefined || updates.m3u8Backup !== undefined) {
      const dataToUpdate: EmissionRowUpdate = {};
      if (updates.m3u8 !== undefined) dataToUpdate.m3u8 = updates.m3u8;
      if (updates.rtmp !== undefined) dataToUpdate.rtmp = updates.rtmp;
      if (updates.m3u8Backup !== undefined) dataToUpdate.m3u8_backup = updates.m3u8Backup;

      supabase
        .from("emission_processes")
        .update(dataToUpdate)
        .eq("id", index)
        .then(({ error }) => {
          if (error) console.error("Error actualizando proceso en DB:", error);
        });
    }
  }, []);

  useEffect(() => {
    const loadFromDatabase = async () => {
      try {
        const { data, error } = await supabase.from("emission_processes").select("*").order("id");
        if (error) throw error;

        if (data && data.length > 0) {
          const loadedProcesses = Array.from({ length: NUM_PROCESSES }, (_, index) => {
            const row = data.find((d) => d.id === index);
            return row ? rowToProcess(row) : defaultProcess();
          });
          setProcesses(loadedProcesses);

          for (let i = 0; i < NUM_PROCESSES; i++) {
            if (!data.some((d) => d.id === i)) {
              await supabase.from("emission_processes").insert({
                id: i,
                m3u8: "",
                rtmp: "",
                preview_suffix: "/video.m3u8",
                is_emitting: false,
                elapsed: 0,
                start_time: 0,
                emit_status: "idle",
                emit_msg: "",
              });
            }
          }
        } else {
          for (let i = 0; i < NUM_PROCESSES; i++) {
            await supabase.from("emission_processes").insert({
              id: i,
              m3u8: "",
              rtmp: "",
              preview_suffix: "/video.m3u8",
              is_emitting: false,
              elapsed: 0,
              start_time: 0,
              emit_status: "idle",
              emit_msg: "",
            });
          }
        }
      } catch (error) {
        console.error("Error cargando procesos:", error);
        toast.error("Error al cargar procesos desde la base de datos");
      } finally {
        setIsLoading(false);
      }
    };

    loadFromDatabase();

    const channel = supabase
      .channel("emission_processes_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "emission_processes" },
        (payload) => {
          if (payload.eventType !== "UPDATE") return;
          const row = payload.new as EmissionRow;

          setProcesses((prev) => {
            if (row.id < 0 || row.id >= NUM_PROCESSES) return prev;
            const next = [...prev];
            next[row.id] = rowToProcess(row, prev[row.id]?.logs || []);
            return next;
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setProcesses((prev) =>
        prev.map((p) => {
          if (p.isEmitiendo && (p.emitStatus === "running" || p.emitStatus === "starting") && p.startTime > 0) {
            return { ...p, elapsed: Math.floor((Date.now() - p.startTime) / 1000) };
          }
          return p;
        })
      );
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const fetchChannelUrl = useCallback(async (processIndex: number) => {
    const config = CHANNEL_CONFIGS[processIndex];
    if (!config.scrapeFn || !config.channelId) return;

    setFetchingChannel(processIndex);
    try {
      const resp = await fetch("/api/local-scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: config.channelId, process_id: processIndex }),
      });
      const data = await resp.json();

      if (!data?.success) throw new Error(data?.error || "Error desconocido");

      updateProcess(processIndex, {
        m3u8: data.url,
        rtmp: processesRef.current[processIndex].rtmp || "",
      });
      toast.success(`✅ URL ${config.name} extraída correctamente`);
    } catch (error) {
      const message = getErrorMessage(error, `Error obteniendo URL ${config.name}`);
      console.error(`Error obteniendo URL ${config.name}:`, error);
      toast.error(`Error obteniendo URL ${config.name}: ${message}`);
    } finally {
      setFetchingChannel(null);
    }
  }, [updateProcess]);

  useEffect(() => {
    const canal6Preset = CHANNEL_CONFIGS[CANAL6_URL_INDEX]?.presetUrl;
    if (!canal6Preset) return;

    setProcesses((prev) => {
      if (prev[CANAL6_URL_INDEX]?.m3u8 === canal6Preset) return prev;
      const next = [...prev];
      next[CANAL6_URL_INDEX] = { ...next[CANAL6_URL_INDEX], m3u8: canal6Preset };
      return next;
    });

    supabase
      .from("emission_processes")
      .update({ m3u8: canal6Preset })
      .eq("id", CANAL6_URL_INDEX)
      .then(({ error }) => {
        if (error) console.error("Error guardando URL oficial de Canal 6:", error);
      });
  }, []);

  useEffect(() => {
    if (isLoading || restoredSessionsRef.current) return;

    processes.forEach((process, index) => {
      if (process.isEmitiendo && process.startTime > 0) {
        const calculatedElapsed = Math.max(0, Math.floor((Date.now() - process.startTime) / 1000));
        updateProcess(index, {
          elapsed: calculatedElapsed,
          emitStatus: "running",
          emitMsg: "Emisión restaurada desde sesión persistente",
        });
      }
    });

    restoredSessionsRef.current = true;
  }, [isLoading, processes, updateProcess]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          id?: string;
          timestamp?: number;
          level?: LogEntry["level"];
          message?: string;
          details?: unknown;
          processId?: string;
          type?: string;
          failureType?: string;
        };

        if (data.timestamp && data.level && data.message) {
          const processIndex = Number.parseInt(data.processId || "", 10);
          if (processIndex >= 0 && processIndex < NUM_PROCESSES) {
            const logEntry: LogEntry = {
              id: data.id || `${Date.now()}-${Math.random()}`,
              timestamp: data.timestamp,
              level: data.level,
              message: data.message,
              details: data.details,
            };

            setProcesses((prev) => {
              const next = [...prev];
              next[processIndex] = {
                ...next[processIndex],
                logs: [...next[processIndex].logs, logEntry].slice(-100),
              };
              return next;
            });

            window.setTimeout(() => {
              const logContainer = logContainerRefs.current[processIndex];
              if (logContainer) {
                logContainer.scrollTop = logContainer.scrollHeight;
              }
            }, 50);
          }
        }

        if (data.type === "failure") {
          const processIndex = Number.parseInt(data.processId || "", 10);
          const failureType = data.failureType;
          const details = typeof data.details === "string" ? data.details : "Error no especificado";

          const failureMessages = {
            source: "🔗 Fallo en URL Fuente",
            rtmp: "📡 Fallo en Destino RTMP",
            server: "🖥️ Fallo en Servidor",
          };

          toast.warning(`⚠️ Advertencia en ${CHANNEL_CONFIGS[processIndex]?.name || `Proceso ${processIndex + 1}`}`, {
            description: `${failureMessages[failureType as keyof typeof failureMessages] || "Advertencia"}: ${details}. Verificando estado...`,
          });

          updateProcess(processIndex, {
            failureReason: failureType,
            failureDetails: details,
          });
        }
      } catch (error) {
        console.error("Error procesando mensaje WebSocket:", error);
      }
    };

    ws.onerror = (error) => {
      console.error("❌ Error en WebSocket:", error);
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [updateProcess]);

  const checkProcessStatus = async (processIndex: number) => {
    try {
      const resp = await fetch(`/api/status?process_id=${processIndex}`);
      const data = await resp.json();

      if (!data.process_running && processesRef.current[processIndex].isEmitiendo) {
        window.setTimeout(() => {
          startEmitToRTMP(processIndex);
        }, 5000);
      }
    } catch {
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
    const process = processesRef.current[processIndex];

    if (processIndex === FILE_UPLOAD_INDEX) {
      if (uploadedFiles.length === 0 || !process.rtmp) {
        updateProcess(processIndex, {
          emitStatus: "error",
          emitMsg: "Falta archivo(s) o RTMP",
        });
        return;
      }

      updateProcess(processIndex, {
        emitStatus: "starting",
        emitMsg: "Subiendo archivos al servidor...",
        reconnectAttempts: 0,
        lastReconnectTime: 0,
        failureReason: undefined,
        failureDetails: undefined,
      });
      setUploadProgress(0);

      try {
        const formData = new FormData();
        uploadedFiles.forEach((file) => formData.append("files", file));
        formData.append("target_rtmp", process.rtmp);
        formData.append("process_id", processIndex.toString());

        const resp = await new Promise<UploadEmitResponse>((resolve, reject) => {
          const xhr = new XMLHttpRequest();

          xhr.upload.addEventListener("progress", (e) => {
            if (e.lengthComputable) {
              const percentComplete = Math.round((e.loaded / e.total) * 100);
              setUploadProgress(percentComplete);
              updateProcess(processIndex, { emitMsg: `Subiendo archivos... ${percentComplete}%` });
            }
          });

          xhr.addEventListener("load", () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                resolve(JSON.parse(xhr.responseText) as UploadEmitResponse);
              } catch {
                resolve({});
              }
            } else {
              reject(new Error(`HTTP ${xhr.status}`));
            }
          });

          xhr.addEventListener("error", () => reject(new Error("Network error")));
          xhr.addEventListener("abort", () => reject(new Error("Upload aborted")));
          xhr.open("POST", "/api/emit/files");
          xhr.send(formData);
        });

        setUploadProgress(100);
        const startTimeUnix = resp.start_time || Math.floor(Date.now() / 1000);

        updateProcess(processIndex, {
          emitStatus: "running",
          emitMsg: "✅ Archivos subidos. Emisión en progreso...",
          elapsed: 0,
          startTime: startTimeUnix * 1000,
          isEmitiendo: true,
        });

        await supabase
          .from("emission_processes")
          .update({ start_time: startTimeUnix, is_emitting: true, emit_status: "running" })
          .eq("id", processIndex);

        toast.success(`${CHANNEL_CONFIGS[processIndex].name} iniciado con archivos locales`);
      } catch (error) {
        const errorMsg = getErrorMessage(error, "Error al subir archivos");
        console.error("Error emitiendo archivos locales:", error);
        setUploadProgress(0);
        updateProcess(processIndex, {
          emitStatus: "error",
          emitMsg: errorMsg,
          isEmitiendo: false,
          failureReason: "server",
          failureDetails: `Error al subir archivos: ${errorMsg}`,
        });
      }
      return;
    }

    const isHlsOutput = HLS_OUTPUT_PROCESSES.has(processIndex);
    if (!process.m3u8 || (!process.rtmp && !isHlsOutput)) {
      updateProcess(processIndex, {
        emitStatus: "error",
        emitMsg: isHlsOutput ? "Falta M3U8 (haz clic en Obtener URL)" : "Falta M3U8 o RTMP",
      });
      return;
    }

    updateProcess(processIndex, {
      emitStatus: "starting",
      emitMsg: "Iniciando emisión en el servidor...",
      reconnectAttempts: 0,
      lastReconnectTime: 0,
      failureReason: undefined,
      failureDetails: undefined,
    });

    try {
      const resp = await fetch("/api/emit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_m3u8: process.m3u8,
          target_rtmp: isHlsOutput ? "hls-local" : process.rtmp,
          process_id: processIndex.toString(),
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as UploadEmitResponse;
      const startTimeUnix = data.start_time || Math.floor(Date.now() / 1000);

      updateProcess(processIndex, {
        emitStatus: "running",
        emitMsg: isHlsOutput ? "✅ Emitiendo HLS" : "✅ Emitiendo a RTMP",
        elapsed: 0,
        startTime: startTimeUnix * 1000,
        isEmitiendo: true,
      });

      await supabase
        .from("emission_processes")
        .update({ start_time: startTimeUnix, is_emitting: true, emit_status: "running" })
        .eq("id", processIndex);

      toast.success(`${CHANNEL_CONFIGS[processIndex].name} iniciado`);
    } catch (error) {
      const errorMsg = getErrorMessage(error, "Error al iniciar stream");
      console.error("Error starting emit:", error);
      updateProcess(processIndex, {
        emitStatus: "error",
        emitMsg: errorMsg,
        isEmitiendo: false,
        failureReason: "server",
        failureDetails: `Error al iniciar stream M3U8: ${errorMsg}`,
      });
    }
  }
...
            {processIndex !== FILE_UPLOAD_INDEX && (
              <div className="flex items-center gap-3 mt-4 p-3 rounded-xl bg-card/50 border border-border">
                <Switch
                  checked={process.nightRest}
                  onCheckedChange={async (checked) => {
                    updateProcess(processIndex, { nightRest: checked });
                    try {
                      const { error } = await supabase
                        .from("emission_processes")
                        .update({ night_rest: checked })
                        .eq("id", processIndex);
                      if (error) throw error;
                      toast.success(`${checked ? '🌙' : '☀️'} Descanso nocturno ${checked ? 'activado' : 'desactivado'} para ${channelConfig.name}`);
                    } catch {
                      toast.error("Error al cambiar descanso nocturno");
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
