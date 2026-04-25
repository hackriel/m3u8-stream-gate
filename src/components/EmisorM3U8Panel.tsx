import React, { useEffect, useRef, useState, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import { useServerMetrics } from "@/hooks/useServerMetrics";
import { LogSnapshotsViewer } from "@/components/LogSnapshotsViewer";

// ⚠️ Importante sobre User-Agent y RTMP desde el navegador:
// - No se puede cambiar el header real "User-Agent" desde JS por seguridad.
//   Usa un proxy/backend y lee el header alterno X-Requested-User-Agent.
// - El navegador NO puede "empujar" directo a RTMP. Para emitir a RTMP
//   hay que disparar un proceso en servidor (p. ej., ffmpeg) que tome la
//   fuente (m3u8) y la publique al RTMP destino. Esta UI llama endpoints
//   /api/emit (POST) y /api/emit/stop (POST) que debes implementar.

const NUM_PROCESSES = 19;
const FILE_UPLOAD_INDEX = 7; // "Subida" process
const DISNEY8_INDEX = 10; // "Disney 8" process - same as Disney 7
const FUTV_URL_INDEX = 11; // "FUTV URL" process - HLS output
const TIGO_URL_INDEX = 12;
const TELETICA_URL_INDEX = 13;
const TDMAS1_URL_INDEX = 14;
const CANAL6_URL_INDEX = 15;
const DISNEY7_URL_INDEX = 16;
const FUTV_ALTERNO_INDEX = 17; // Canal eventual con URL pegada del usuario, mismo destino que FUTV URL
const FUTV_SRT_INDEX = 18; // FUTV SRT: ingest SRT desde OBS por puerto 9002
const PUBLIC_HLS_BASE_URL = "http://167.17.69.116:3001";
const TIGO_OBS_INGEST_URL = "srt://167.17.69.116:9000?streamid=tigo&latency=2000000";
const DISNEY7_OBS_INGEST_URL = "srt://167.17.69.116:9001?streamid=disney7&latency=2000000";
const FUTV_SRT_OBS_INGEST_URL = "srt://167.17.69.116:9002?streamid=futv&latency=2000000";
const SRT_INTERNAL_SOURCE_URL = "srt://obs";

// Procesos ocultos legacy
// 2, 8, 9: Tigo legacy (descartados)
// 1, 3, 4, 5, 6, 7: tabs antiguos (FUTV, TDmas 1, Teletica, Canal 6, Multimedios, Subida)
//   reemplazados por la nueva tecnología (FUTV URL, TDMAS 1 URL, TELETICA URL, CANAL 6 URL, FUTV ALTERNO).
//   La lógica permanece en el código por si se necesita revertir; solo se ocultan los tabs.
const HIDDEN_PROCESSES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
// Procesos que emiten HLS local (sin RTMP)
const HLS_OUTPUT_PROCESSES = new Set([FUTV_URL_INDEX, TIGO_URL_INDEX, TELETICA_URL_INDEX, TDMAS1_URL_INDEX, CANAL6_URL_INDEX, DISNEY7_URL_INDEX, FUTV_ALTERNO_INDEX, FUTV_SRT_INDEX]);
// Procesos que reciben SRT desde OBS (entrada manual interna)
const OBS_INGEST_PROCESSES = new Set<number>([TIGO_URL_INDEX, DISNEY7_URL_INDEX, FUTV_SRT_INDEX]);
// Procesos eventuales que aceptan URL pegada del usuario y necesitan scraping dinámico
const PASTE_URL_PROCESSES = new Set<number>([FUTV_ALTERNO_INDEX]);
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
  activeTime: number;
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
  alwaysOn: boolean;
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

type EmissionProcessRow = Tables<"emission_processes">;

type EmitStatus = EmissionProcess["emitStatus"];

interface LocalScrapeResponse {
  success?: boolean;
  error?: string;
  url?: string;
}

interface FileUploadResponse {
  start_time?: number;
}

const getErrorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const mapRowToProcess = (row: EmissionProcessRow): EmissionProcess => {
  const isLiveStatus = row.emit_status === "running" || row.emit_status === "starting";
  const hasStartTime = Boolean(row.start_time && row.start_time > 0);
  const startTimeSeconds = row.start_time || 0;
  const startTimeMs = startTimeSeconds > 0 ? startTimeSeconds * 1000 : 0;
  const isRunning = (row.is_emitting || isLiveStatus) && hasStartTime;
  const elapsedSeconds = isRunning
    ? Math.max(0, Math.floor(Date.now() / 1000) - startTimeSeconds)
    : Math.max(row.active_time || 0, row.elapsed || 0);
  const loadFailure = isRunning || row.is_emitting;

  return {
    m3u8: row.m3u8 || "",
    m3u8Backup: row.m3u8_backup || "",
    rtmp: row.rtmp || "",
    previewSuffix: row.preview_suffix || "/video.m3u8",
    isEmitiendo: row.is_emitting || isRunning,
    elapsed: elapsedSeconds,
    activeTime: row.active_time || 0,
    startTime: startTimeMs,
    emitStatus: (row.emit_status as EmitStatus) || "idle",
    emitMsg: row.emit_msg || "",
    reconnectAttempts: 0,
    lastReconnectTime: 0,
    failureReason: loadFailure ? (row.failure_reason || undefined) : undefined,
    failureDetails: loadFailure ? (row.failure_details || undefined) : undefined,
    logs: [],
    processLogsFromDB: row.process_logs || "",
    recoveryCount: row.recovery_count || 0,
    lastSignalDuration: row.last_signal_duration || 0,
    nightRest: row.night_rest || false,
    alwaysOn: (row as unknown as { always_on?: boolean }).always_on || false,
    sourceUrl: row.source_url || "",
  };
};

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
  { name: "TIGO SRT", scrapeFn: null, channelId: null, fetchLabel: "", presetUrl: SRT_INTERNAL_SOURCE_URL },
  { name: "TELETICA URL", scrapeFn: "scrape-channel", channelId: "617c2f66e4b045a692106126", fetchLabel: "🔄 Teletica" },
  { name: "TDMAS 1 URL", scrapeFn: "scrape-channel", channelId: "66608d188f0839b8a740cfe9", fetchLabel: "🔄 TDmas1" },
  { name: "CANAL 6 URL", scrapeFn: null, channelId: null, fetchLabel: "🏛️ Repretel", presetUrl: "https://d2qsan2ut81n2k.cloudfront.net/live/02f0dc35-8fd4-4021-8fa0-96c277f62653/ts:abr.m3u8" },
  { name: "DISNEY 7 SRT", scrapeFn: null, channelId: null, fetchLabel: "", presetUrl: SRT_INTERNAL_SOURCE_URL },
  { name: "FUTV ALTERNO", scrapeFn: "scrape-channel", channelId: null, fetchLabel: "🔄 Extraer de URL" },
  { name: "FUTV SRT", scrapeFn: null, channelId: null, fetchLabel: "", presetUrl: SRT_INTERNAL_SOURCE_URL },
];

const defaultProcess = (): EmissionProcess => ({
  m3u8: '',
  m3u8Backup: '',
  rtmp: '',
  previewSuffix: '/video.m3u8',
  isEmitiendo: false,
  elapsed: 0,
  activeTime: 0,
  startTime: 0,
  emitStatus: "idle",
  emitMsg: '',
  reconnectAttempts: 0,
  lastReconnectTime: 0,
  logs: [],
  recoveryCount: 0,
  lastSignalDuration: 0,
  nightRest: false,
  alwaysOn: false,
});

export default function EmisorM3U8Panel() {
  const logContainerRefs = useRef<Array<HTMLDivElement | null>>([]);
  
  const [activeTab, setActiveTab] = useState(() => sessionStorage.getItem("emisor-active-tab") || "0");
  const [isLoading, setIsLoading] = useState(true);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const wsRef = useRef<WebSocket | null>(null);
  
  const [processes, setProcesses] = useState<EmissionProcess[]>(
    Array.from({ length: NUM_PROCESSES }, defaultProcess)
  );

  const reconcileWithServerStatus = useCallback(async () => {
    try {
      const resp = await fetch('/api/status');
      if (!resp.ok) return;

      const data = await resp.json();
      const serverProcesses = data?.processes as Record<string, { status?: string; process_running?: boolean }> | undefined;
      if (!serverProcesses) return;

      setProcesses(prev => prev.map((process, index) => {
        const serverState = serverProcesses[index.toString()];
        if (!serverState) return process;

        const serverRunning = Boolean(serverState.process_running);
        const serverStatus = (serverState.status as EmitStatus | undefined) || process.emitStatus;
        const recoveredStartTime = process.startTime;
        const recoveredElapsed = serverRunning
          ? recoveredStartTime > 0
            ? Math.max(process.activeTime, process.elapsed, Math.floor((Date.now() - recoveredStartTime) / 1000))
            : Math.max(process.activeTime, process.elapsed)
          : Math.max(process.activeTime, process.elapsed);

        if (serverRunning === process.isEmitiendo && serverStatus === process.emitStatus) {
          return serverRunning && recoveredElapsed !== process.elapsed
            ? { ...process, elapsed: recoveredElapsed }
            : process;
        }

        return {
          ...process,
          isEmitiendo: serverRunning,
          emitStatus: serverRunning
            ? (serverStatus === 'idle' || serverStatus === 'stopped' ? 'running' : serverStatus)
            : (serverStatus === 'running' ? 'idle' : serverStatus),
          emitMsg: serverRunning
            ? (process.emitMsg || '✅ Emitiendo')
            : (process.emitStatus === 'running' ? '' : process.emitMsg),
          elapsed: recoveredElapsed,
        };
      }));
    } catch {
      // Ignorar: la UI ya recibe estado por realtime y DB
    }
  }, []);

  
  // Cargar datos desde Supabase al montar el componente
  useEffect(() => {
    sessionStorage.setItem("emisor-active-tab", activeTab);
  }, [activeTab]);

  useEffect(() => {
    const loadFromDatabase = async () => {
      try {
        const { data, error } = await supabase
          .from('emission_processes')
          .select('*')
          .order('id');
        
        if (error) throw error;
        
        const baseRows = Array.from({ length: NUM_PROCESSES }, (_, id) => ({
          id,
          m3u8: '',
          rtmp: '',
          preview_suffix: '/video.m3u8',
          is_emitting: false,
          elapsed: 0,
          active_time: 0,
          down_time: 0,
          start_time: 0,
          emit_status: 'idle',
          emit_msg: '',
        }));

        if (data && data.length > 0) {
          const loadedProcesses: EmissionProcess[] = Array.from({ length: NUM_PROCESSES }, (_, index) => {
            const row = data.find(d => d.id === index);
            return row ? mapRowToProcess(row) : defaultProcess();
          });
          setProcesses(loadedProcesses);

          const existingIds = new Set(data.map(row => row.id));
          const missingRows = baseRows.filter(row => !existingIds.has(row.id));
          if (missingRows.length > 0) {
            const { error: seedError } = await supabase.from('emission_processes').upsert(missingRows, { onConflict: 'id' });
            if (seedError) throw seedError;
          }
        } else {
          const { error: seedError } = await supabase.from('emission_processes').upsert(baseRows, { onConflict: 'id' });
          if (seedError) throw seedError;
        }
      } catch (error) {
        console.error('Error cargando procesos:', error);
        toast.error('Error al cargar procesos desde la base de datos');
      } finally {
        setIsLoading(false);
      }
    };
    
    loadFromDatabase().finally(() => {
      void reconcileWithServerStatus();
    });
    
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
            const row = payload.new as EmissionProcessRow;
            setProcesses(prev => {
              const newProcesses = [...prev];
              if (row.id >= 0 && row.id < NUM_PROCESSES) {
                const previousProcess = prev[row.id];
                const mappedProcess = mapRowToProcess(row);
                const sameLiveSession = Boolean(
                  previousProcess?.isEmitiendo &&
                  previousProcess.startTime > 0 &&
                  row.start_time > 0 &&
                  previousProcess.startTime === row.start_time * 1000
                );

                const shouldPreserveLiveSession = Boolean(
                  sameLiveSession &&
                  previousProcess.isEmitiendo &&
                  (!mappedProcess.isEmitiendo || mappedProcess.startTime === 0) &&
                  (row.emit_status === 'running' || row.emit_status === 'starting')
                );

                newProcesses[row.id] = {
                  ...mappedProcess,
                  isEmitiendo: shouldPreserveLiveSession ? true : mappedProcess.isEmitiendo,
                  activeTime: Math.max(previousProcess.activeTime, mappedProcess.activeTime),
                  startTime: shouldPreserveLiveSession ? previousProcess.startTime : mappedProcess.startTime,
                  elapsed: sameLiveSession
                    ? Math.max(previousProcess.activeTime, previousProcess.elapsed, mappedProcess.activeTime, mappedProcess.elapsed)
                    : Math.max(mappedProcess.activeTime, mappedProcess.elapsed),
                  logs: prev[row.id]?.logs || [],
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
  }, [reconcileWithServerStatus]);

  useEffect(() => {
    const interval = setInterval(() => {
      void reconcileWithServerStatus();
    }, 5000);

    return () => clearInterval(interval);
  }, [reconcileWithServerStatus]);
  
  // Reloj global para recalcular métricas vivas sin depender de escrituras en DB
  useEffect(() => {
    const interval = setInterval(() => {
      setClockNow(Date.now());
    }, 1000);

    return () => clearInterval(interval);
  }, []);
  
  // Estado específico para el proceso de subida (archivos locales)
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [fetchingChannel, setFetchingChannel] = useState<number | null>(null);
  // URL pegada por el usuario para canales tipo FUTV ALTERNO (eventuales)
  const [pasteUrls, setPasteUrls] = useState<Record<number, string>>({});
  const { metricsHistory, latestMetrics } = useServerMetrics();

  // Extrae el channel_id del query param 'id' de una URL TDMax tipo:
  // https://www.app.tdmax.com/player?id=689b81b08f08c8be77f8eb43&type=channel
  const extractTdmaxChannelId = (raw: string): string | null => {
    if (!raw) return null;
    const trimmed = raw.trim();
    // Acepta también un id "pelado" (24 hex chars de Mongo)
    if (/^[a-f0-9]{24}$/i.test(trimmed)) return trimmed;
    try {
      const u = new URL(trimmed);
      const id = u.searchParams.get('id');
      if (id && /^[a-f0-9]{24}$/i.test(id)) return id;
      return null;
    } catch {
      return null;
    }
  };

  // Scraping para FUTV ALTERNO: el channel_id viene de la URL pegada.
  const fetchPastedChannelUrl = useCallback(async (processIndex: number) => {
    const pasted = (pasteUrls[processIndex] || '').trim();
    const channelId = extractTdmaxChannelId(pasted);
    if (!channelId) {
      toast.error('URL inválida. Pega una URL tipo https://www.app.tdmax.com/player?id=XXXX&type=channel');
      return;
    }

    setFetchingChannel(processIndex);
    try {
      const resp = await fetch('/api/local-scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_id: channelId, process_id: processIndex, player_url: pasted }),
      });
      const data = await resp.json();
      if (!data?.success) throw new Error(data?.error || 'Error desconocido');
      const streamUrl = data.url;
      updateProcess(processIndex, { m3u8: streamUrl, rtmp: 'hls-local' });
      toast.success(`✅ URL alterna extraída (${channelId.substring(0, 8)}…) — player URL guardada para auto-recovery`);
    } catch (error: unknown) {
      const message = getErrorMessage(error, 'Error desconocido');
      toast.error(`Error obteniendo URL alterna: ${message}`);
    } finally {
      setFetchingChannel(null);
    }
  }, [pasteUrls]);

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
    } catch (error: unknown) {
      const message = getErrorMessage(error, 'Error desconocido');
      console.error(`Error obteniendo URL ${config.name}:`, error);
      toast.error(`Error obteniendo URL ${config.name}: ${message}`);
    } finally {
      setFetchingChannel(null);
    }
  }, []);

  useEffect(() => {
    const canal6Preset = CHANNEL_CONFIGS[CANAL6_URL_INDEX]?.presetUrl;
    const tigoPreset = CHANNEL_CONFIGS[TIGO_URL_INDEX]?.presetUrl;
    const disney7Preset = CHANNEL_CONFIGS[DISNEY7_URL_INDEX]?.presetUrl;
    const futvSrtPreset = CHANNEL_CONFIGS[FUTV_SRT_INDEX]?.presetUrl;
    const tigoRtmp = 'hls-local';
    setProcesses(prev => {
      let changed = false;
      const next = [...prev];

      if (tigoPreset && (next[TIGO_URL_INDEX]?.m3u8 !== tigoPreset || next[TIGO_URL_INDEX]?.rtmp !== tigoRtmp)) {
        next[TIGO_URL_INDEX] = { ...next[TIGO_URL_INDEX], m3u8: tigoPreset, rtmp: tigoRtmp };
        changed = true;
      }

      if (disney7Preset && (next[DISNEY7_URL_INDEX]?.m3u8 !== disney7Preset || next[DISNEY7_URL_INDEX]?.rtmp !== tigoRtmp)) {
        next[DISNEY7_URL_INDEX] = { ...next[DISNEY7_URL_INDEX], m3u8: disney7Preset, rtmp: tigoRtmp };
        changed = true;
      }

      if (futvSrtPreset && (next[FUTV_SRT_INDEX]?.m3u8 !== futvSrtPreset || next[FUTV_SRT_INDEX]?.rtmp !== tigoRtmp)) {
        next[FUTV_SRT_INDEX] = { ...next[FUTV_SRT_INDEX], m3u8: futvSrtPreset, rtmp: tigoRtmp };
        changed = true;
      }

      if (canal6Preset && next[CANAL6_URL_INDEX]?.m3u8 !== canal6Preset) {
        next[CANAL6_URL_INDEX] = { ...next[CANAL6_URL_INDEX], m3u8: canal6Preset };
        changed = true;
      }

      return changed ? next : prev;
    });

    if (tigoPreset) {
      supabase
        .from('emission_processes')
        .update({ m3u8: tigoPreset, rtmp: tigoRtmp })
        .eq('id', TIGO_URL_INDEX)
        .then(({ error }) => {
          if (error) console.error('Error guardando preset de TIGO SRT:', error);
        });
    }

    if (disney7Preset) {
      supabase
        .from('emission_processes')
        .update({ m3u8: disney7Preset, rtmp: tigoRtmp })
        .eq('id', DISNEY7_URL_INDEX)
        .then(({ error }) => {
          if (error) console.error('Error guardando preset de DISNEY 7 SRT:', error);
        });
    }

    if (futvSrtPreset) {
      supabase
        .from('emission_processes')
        .update({ m3u8: futvSrtPreset, rtmp: tigoRtmp })
        .eq('id', FUTV_SRT_INDEX)
        .then(({ error }) => {
          if (error) console.error('Error guardando preset de FUTV SRT:', error);
        });
    }

    if (!canal6Preset) return;

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
      const dataToUpdate: Partial<Pick<EmissionProcessRow, 'm3u8' | 'rtmp' | 'm3u8_backup'>> = {};
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

  const toggleAlwaysOn = async (processIndex: number, checked: boolean, channelName: string) => {
    updateProcess(processIndex, { alwaysOn: checked });

    try {
      const resp = await fetch('/api/always-on', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ process_id: processIndex, enabled: checked }),
      });

      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'No se pudo actualizar Encendido siempre');
      }

      if (typeof data?.always_on !== 'boolean') {
        throw new Error('Respuesta inválida del servidor al actualizar Encendido siempre');
      }

      updateProcess(processIndex, { alwaysOn: Boolean(data?.always_on) });
      toast.success(`${checked ? '🔁' : '⏹️'} Encendido siempre ${checked ? 'activado' : 'desactivado'} para ${channelName}`);
    } catch (error) {
      console.error('Error al cambiar Encendido siempre:', error);
      toast.error('Error al cambiar Encendido siempre');
      updateProcess(processIndex, { alwaysOn: !checked });
    }
  };

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
              const logContainer = logContainerRefs.current[processIndex];
              if (logContainer) {
                logContainer.scrollTop = logContainer.scrollHeight;
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
    const process = processesRef.current[processIndex];
    
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
        
        const resp = await new Promise<FileUploadResponse>((resolve, reject) => {
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
       } catch (error: unknown) {
         console.error("Error emitiendo archivos locales:", error);
        setUploadProgress(0);
         const errorMsg = getErrorMessage(error, "Error al subir archivos");
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
    } catch (error: unknown) {
      console.error("Error starting emit:", error);
      const errorMsg = getErrorMessage(error, "Error al iniciar stream");
      updateProcess(processIndex, {
        emitStatus: "error",
        emitMsg: errorMsg,
        isEmitiendo: false,
        failureReason: "server",
        failureDetails: `Error al iniciar stream M3U8: ${errorMsg}`
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

    // (función onReiniciar definida más abajo)

    // Marcar UI como deteniendo de inmediato para que el usuario vea feedback.
    updateProcess(processIndex, {
      emitStatus: "stopping",
      emitMsg: "Limpiando proceso...",
    });

    // SIEMPRE pedir al server que detenga FFmpeg, aunque la UI diga isEmitiendo=false.
    // (Cubre el caso de FFmpeg zombi del lado del server tras un error/recovery fallido).
    try {
      await fetch("/api/emit/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ process_id: processIndex.toString() })
      });
    } catch (e) {
      console.error("Error parando proceso al borrar:", e);
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

    // Limpiar estado local DESPUÉS del stop para que no haya pisada de realtime.
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

    // Limpieza completa en DB de manera atómica (incluye flags de emisión por si quedaron en true).
    await supabase
      .from('emission_processes')
      .update({
        m3u8: '',
        rtmp: '',
        source_url: '',
        is_emitting: false,
        is_active: false,
        emit_status: 'idle',
        emit_msg: '',
        start_time: 0,
        elapsed: 0,
        ffmpeg_pid: null,
        recovery_count: 0,
        last_signal_duration: 0,
        failure_reason: null,
        failure_details: null,
      })
      .eq('id', processIndex);
    
    toast.success(`${CHANNEL_CONFIGS[processIndex].name} eliminado`);
    console.log(`🧹 ${CHANNEL_CONFIGS[processIndex].name} limpiado completamente`);
  }

  // 🔄 Reinicio en caliente con sesión fresca:
  // - Mata el FFmpeg actual del canal.
  // - Limpia cookies/token cacheados en el server.
  // - Vuelve a arrancar con un User-Agent rotativo nuevo.
  // NO toca "Encendido siempre" (alwaysOn).
  async function onReiniciar(processIndex: number) {
    const proc = processes[processIndex];
    const channelName = CHANNEL_CONFIGS[processIndex]?.name ?? `Proceso ${processIndex}`;

    updateProcess(processIndex, {
      emitStatus: "starting",
      emitMsg: "Reiniciando con sesión fresca...",
    });

    try {
      const resp = await fetch("/api/emit/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          process_id: processIndex.toString(),
          source_m3u8: proc.m3u8 || undefined,
          target_rtmp: proc.rtmp || undefined,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        toast.error(`Reinicio falló: ${data?.error ?? resp.statusText}`);
        updateProcess(processIndex, { emitStatus: "error", emitMsg: data?.error ?? "Reinicio falló" });
        return;
      }
      toast.success(`${channelName} reiniciado con sesión fresca 🎭`);
    } catch (e: any) {
      toast.error(`Error al reiniciar: ${e?.message ?? e}`);
      updateProcess(processIndex, { emitStatus: "error", emitMsg: "Error al reiniciar" });
    }
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
        if (isTigo) return "Error en TIGO SRT. Verifica que OBS esté enviando señal al puerto 9000 del VPS.";
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
      { bg: "bg-sky-500", text: "text-sky-500", stroke: "#0ea5e9", name: "TIGO SRT" },
      { bg: "bg-cyan-500", text: "text-cyan-500", stroke: "#06b6d4", name: "TELETICA URL" },
      { bg: "bg-lime-500", text: "text-lime-500", stroke: "#84cc16", name: "TDMAS 1 URL" },
      { bg: "bg-amber-500", text: "text-amber-500", stroke: "#f59e0b", name: "CANAL 6 URL" },
      { bg: "bg-gray-400", text: "text-gray-300", stroke: "#d1d5db", name: "DISNEY 7 SRT" },
      { bg: "bg-rose-500", text: "text-rose-500", stroke: "#f43f5e", name: "FUTV ALTERNO" },
      { bg: "bg-fuchsia-500", text: "text-fuchsia-500", stroke: "#d946ef", name: "FUTV SRT" },
    ];
    return colors[processIndex];
  };

  // Función para renderizar un tab de proceso
  const renderProcessTab = (processIndex: number) => {
    const process = processes[processIndex];
    const channelConfig = CHANNEL_CONFIGS[processIndex];
    const liveElapsed = process.isEmitiendo && process.startTime > 0
      ? Math.max(0, Math.floor((clockNow - process.startTime) / 1000))
      : process.elapsed;

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
                <label className="block text-sm mb-2 text-muted-foreground">
                  {OBS_INGEST_PROCESSES.has(processIndex)
                    ? 'Entrada SRT (OBS)'
                    : PASTE_URL_PROCESSES.has(processIndex)
                      ? 'URL del player TDMax (pega aquí)'
                      : 'URL M3U8 (fuente)'}
                </label>
                {PASTE_URL_PROCESSES.has(processIndex) && (
                  <div className="flex gap-2 mb-2">
                    <input
                      type="url"
                      placeholder="https://www.app.tdmax.com/player?id=XXXXX&type=channel"
                      value={pasteUrls[processIndex] || ''}
                      onChange={(e) => setPasteUrls(prev => ({ ...prev, [processIndex]: e.target.value }))}
                      className="flex-1 bg-card border-2 border-amber-400/40 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-amber-400/50 transition-all duration-200"
                    />
                    <button
                      onClick={() => fetchPastedChannelUrl(processIndex)}
                      disabled={fetchingChannel !== null || !(pasteUrls[processIndex] || '').trim()}
                      className="px-4 py-3 rounded-xl bg-amber-500 hover:bg-amber-500/90 active:scale-[.98] transition-all duration-200 font-medium text-amber-50 shadow-lg disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap"
                      title="Extraer M3U8 de la URL del player"
                    >
                      {fetchingChannel === processIndex ? (
                        <span className="flex items-center gap-2">
                          <span className="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-amber-50" />
                          Extrayendo...
                        </span>
                      ) : (
                        '🔄 Extraer'
                      )}
                    </button>
                  </div>
                )}
                <div className="flex gap-2 mb-4">
                  <input
                    type="url"
                    placeholder={
                      processIndex === TIGO_URL_INDEX
                        ? TIGO_OBS_INGEST_URL
                        : processIndex === DISNEY7_URL_INDEX
                          ? DISNEY7_OBS_INGEST_URL
                          : processIndex === FUTV_SRT_INDEX
                            ? FUTV_SRT_OBS_INGEST_URL
                            : PASTE_URL_PROCESSES.has(processIndex)
                            ? 'M3U8 extraído (auto-completado)'
                            : 'https://servidor/origen/playlist.m3u8'
                    }
                    value={process.m3u8}
                    onChange={(e) => updateProcess(processIndex, { m3u8: e.target.value })}
                    readOnly={PASTE_URL_PROCESSES.has(processIndex)}
                    className={`flex-1 bg-card border-2 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-primary/50 transition-all duration-200 ${
                      processIndex === 5 && process.isEmitiendo && process.sourceUrl && process.m3u8
                        && (process.sourceUrl === process.m3u8 || process.sourceUrl.startsWith(process.m3u8))
                        ? 'border-yellow-400 shadow-[0_0_8px_rgba(250,204,21,0.4)]'
                        : PASTE_URL_PROCESSES.has(processIndex)
                          ? 'border-border bg-muted/40'
                          : 'border-border'
                    }`}
                  />
                  {channelConfig.scrapeFn && !PASTE_URL_PROCESSES.has(processIndex) && (
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
                [FUTV_URL_INDEX]: 'futv',
                [TIGO_URL_INDEX]: 'Tigo',
                [TELETICA_URL_INDEX]: 'Teletica',
                [TDMAS1_URL_INDEX]: 'Tdmas1',
                [CANAL6_URL_INDEX]: 'Canal6',
                [DISNEY7_URL_INDEX]: 'Disney7',
                [FUTV_ALTERNO_INDEX]: 'futv',
                [FUTV_SRT_INDEX]: 'futv',
              };
              const hlsSlug = hlsSlugs[processIndex] || `stream_${processIndex}`;
              const hlsUrl = `${PUBLIC_HLS_BASE_URL}/live/${hlsSlug}/playlist.m3u8`;
              const isObsIngest = OBS_INGEST_PROCESSES.has(processIndex);
              const obsIngestUrl = processIndex === TIGO_URL_INDEX
                ? TIGO_OBS_INGEST_URL
                : processIndex === DISNEY7_URL_INDEX
                  ? DISNEY7_OBS_INGEST_URL
                  : processIndex === FUTV_SRT_INDEX
                    ? FUTV_SRT_OBS_INGEST_URL
                    : '';
              return (
              <>
                <h2 className="text-lg font-medium mb-3 text-accent">📺 URL HLS Generada</h2>
                <div className="bg-card/50 border border-border rounded-xl p-4 mb-4">
                  {isObsIngest || process.isEmitiendo ? (
                    <div className="space-y-2">
                      {isObsIngest && (
                        <>
                          <p className="text-xs text-muted-foreground">
                            SRT de entrada para OBS:
                          </p>
                          <div className="flex items-center gap-2">
                            <code className="flex-1 bg-background border border-primary/30 rounded-lg px-3 py-2 text-sm font-mono text-primary break-all">
                              {obsIngestUrl}
                            </code>
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(obsIngestUrl);
                                toast.success('URL SRT copiada al portapapeles');
                              }}
                              className="px-3 py-2 rounded-lg bg-primary/20 hover:bg-primary/30 text-primary text-sm transition-all"
                            >
                              📋
                            </button>
                          </div>
                        </>
                      )}
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
                        {isObsIngest
                          ? '💡 Envía desde OBS a esa SRT y tus clientes consumirán la HLS fija de abajo.'
                          : '💡 Esta URL es fija y no cambia. Agrégala directamente a XUI como source.'}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {isObsIngest
                        ? 'Usa Emitir para abrir la salida HLS y Detener cuando cortes OBS para evitar reinicios y ruido en logs.'
                        : 'La URL se generará al iniciar la emisión. Primero obtén la señal y presiona "Emitir HLS".'}
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
                  {OBS_INGEST_PROCESSES.has(processIndex) ? '📺 Emitir' : HLS_OUTPUT_PROCESSES.has(processIndex) ? '📺 Emitir HLS' : '🚀 Emitir a RTMP'}
                </button>
              ) : (
                <button 
                  onClick={() => stopEmit(processIndex)} 
                  className="px-6 py-3 rounded-xl bg-warning hover:bg-warning/90 active:scale-[.98] transition-all duration-200 font-medium text-warning-foreground shadow-lg hover:shadow-xl"
                >
                  {OBS_INGEST_PROCESSES.has(processIndex) ? '⏹️ Detener' : '⏹️ Detener emisión'}
                </button>
              )}
              {!OBS_INGEST_PROCESSES.has(processIndex) && (
                <button 
                  onClick={() => onBorrar(processIndex)} 
                  className="px-4 py-3 rounded-xl bg-destructive hover:bg-destructive/90 active:scale-[.98] transition-all duration-200 font-medium text-destructive-foreground shadow-lg hover:shadow-xl"
                >
                  🗑️ Borrar
                </button>
              )}
              {!OBS_INGEST_PROCESSES.has(processIndex) && process.isEmitiendo && (
                <button
                  onClick={() => onReiniciar(processIndex)}
                  title="Cierra FFmpeg, limpia cookies/token y vuelve a abrir con User-Agent nuevo (sesión fresca)"
                  className="px-4 py-3 rounded-xl bg-accent hover:bg-accent/90 active:scale-[.98] transition-all duration-200 font-medium text-accent-foreground shadow-lg hover:shadow-xl"
                >
                  🔄 Reiniciar
                </button>
              )}
            </div>

            {/* Always-On Toggle (excluye TIGO SRT, DISNEY 7 SRT y FUTV SRT que dependen de OBS local) */}
            {processIndex !== FILE_UPLOAD_INDEX && !OBS_INGEST_PROCESSES.has(processIndex) && (
              <div className="flex items-center gap-3 mt-4 p-3 rounded-xl bg-card/50 border border-primary/30">
                <Switch
                  checked={process.alwaysOn}
                  onCheckedChange={(checked) => void toggleAlwaysOn(processIndex, checked, channelConfig.name)}
                />
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">🔁 Encendido siempre</span>
                  <span className="text-xs text-muted-foreground">Auto-relanza tras reinicios y refresca URL a las 12:00 AM y 5:00 AM (hora CR)</span>
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
                    <span className="font-semibold text-lg">{process.isEmitiendo ? "🟢 Emitiendo" : "🔴 Caído"}</span>
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
                  <span className="font-mono text-3xl font-bold text-primary">{formatSeconds(liveElapsed)}</span>
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
                    <span className="font-mono text-xl font-semibold text-warning">{formatSeconds(liveElapsed)}</span>
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
            ref={(element) => {
              logContainerRefs.current[processIndex] = element;
            }}
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
