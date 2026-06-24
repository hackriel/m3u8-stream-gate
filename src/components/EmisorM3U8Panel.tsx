import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
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

const NUM_PROCESSES = 29;
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
const RANDOM_DISNEY7_INDEX = 19; // RANDOM Disney 7: M3U passthrough → mismo destino que Disney 7 SRT
const CANAL6_SRT_INDEX = 20; // CANAL 6 SRT: ingest SRT desde OBS por puerto 9003
const TELETICA_SRT_INDEX = 21; // TELETICA SRT: ingest SRT desde Pi5 por puerto 9004
const FOXMAS_SRT_INDEX = 22; // FOX+ SRT: ingest SRT desde Pi5 por puerto 9005
const FOX_SRT_INDEX = 23;    // FOX SRT:  ingest SRT desde Pi5 por puerto 9006
const FOXMAS_URL_INDEX = 24; // FOX+ URL: scraping TDMax vía edge function (mismo patrón que TELETICA URL)
const FOX_URL_INDEX = 25;    // FOX URL: scraping TDMax vía edge function (canal FOX, mismo patrón que FOX+ URL)
const FOXMAS_ALTERNO_INDEX = 26; // FOX+ ALTERNO: URL eventual pegada (mismo patrón que FUTV ALTERNO, slug 'foxmas')
const CANAL8_URL_INDEX = 27; // Canal 8 URL: TELECABLE-only (contentId MULTIMEDIOS), slug HLS Canal8
const CANAL2_URL_INDEX = 28; // Canal 2 URL: TELECABLE-only (contentId CDR), slug HLS Canal2

// Procesos que usan la cuenta TDMax 'pi' (info@media.cr) en vez de la principal.
// Debe coincidir con PI_ACCOUNT_PROCESSES en server.js.
const PI_ACCOUNT_PROCESSES = new Set<number>([15, 24, 25, 26]);

// Scraping con fallback: intenta /api/local-scrape (VPS, token con IP correcta).
// Si no responde JSON (preview de Lovable, dev, o VPS caído), cae a la
// edge function `scrape-channel` directamente.
async function scrapeChannelWithFallback(
  channelId: string,
  processIndex: number,
  playerUrl?: string,
): Promise<{ success: boolean; url?: string; error?: string }> {
  const body: Record<string, unknown> = { channel_id: channelId, process_id: processIndex };
  if (playerUrl) body.player_url = playerUrl;
  const shouldFallbackFromLocalError = (error?: string, status?: number) => {
    if (status === 429) return false;
    return /fetch failed|UND_ERR_|CONNECT_TIMEOUT|ETIMEDOUT|ECONN|ENOTFOUND|EAI_AGAIN|timeout/i.test(error || '');
  };

  // 1) Intento local (producción VPS)
  try {
    const resp = await fetch('/api/local-scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await resp.json();
      if (data?.success || !shouldFallbackFromLocalError(data?.error, resp.status)) {
        return data;
      }
      console.warn('[scrape] /api/local-scrape falló por red del VPS, usando edge function:', data?.error);
    }
    // No JSON → muy probablemente estamos en la preview de Lovable y el
    // endpoint no existe (devuelve index.html). Continuar al fallback.
    console.warn('[scrape] /api/local-scrape no devolvió JSON, usando edge function');
  } catch (e) {
    console.warn('[scrape] /api/local-scrape falló, usando edge function:', e);
  }

  // 2) Fallback: edge function scrape-channel
  const account = PI_ACCOUNT_PROCESSES.has(processIndex) ? 'pi' : 'default';
  const { data, error } = await supabase.functions.invoke('scrape-channel', {
    body: { channel_id: channelId, process_id: String(processIndex), account },
  });
  if (error) return { success: false, error: error.message };
  return data as { success: boolean; url?: string; error?: string };
}
const PUBLIC_HLS_BASE_URL = "http://167.17.69.116:3001";
const TIGO_OBS_INGEST_URL = "srt://167.17.69.116:9000?streamid=tigo&latency=2000000";
const DISNEY7_OBS_INGEST_URL = "srt://167.17.69.116:9001?streamid=disney7&latency=2000000";
const FUTV_SRT_OBS_INGEST_URL = "srt://167.17.69.116:9002?streamid=futv&latency=2000000";
const CANAL6_SRT_OBS_INGEST_URL = "srt://167.17.69.116:9003?streamid=canal6&latency=2000000";
const TELETICA_SRT_OBS_INGEST_URL = "srt://167.17.69.116:9004?streamid=teletica&latency=2000000";
const FOXMAS_SRT_OBS_INGEST_URL = "srt://167.17.69.116:9005?streamid=foxmas&latency=2000000";
const FOX_SRT_OBS_INGEST_URL = "srt://167.17.69.116:9006?streamid=fox&latency=2000000";
const SRT_INTERNAL_SOURCE_URL = "srt://obs";

type OutputProfile = "passthrough" | "normal" | "balanced" | "optimized";
const DEFAULT_OUTPUT_PROFILE: OutputProfile = "normal";
const OUTPUT_PROFILE_LABELS: Record<OutputProfile, string> = {
  passthrough: "Passthrough · tal cual lo manda OBS (sin re-encode)",
  normal: "Normal · 720p CBR 2000k + AAC 128k",
  balanced: "Balanceada · 540p CBR 1500k + AAC 128k (faster)",
  optimized: "Optimizada · 480p CBR 1200k + AAC 128k (faster)",
};
// IDs SRT ingest: arrancan por defecto en Passthrough (sin re-encode).
const SRT_INGEST_INDEXES = new Set<number>([16, 18, 20, 21, 22, 23]);
const getDefaultOutputProfile = (processIndex: number): OutputProfile =>
  SRT_INGEST_INDEXES.has(processIndex) ? "passthrough" : DEFAULT_OUTPUT_PROFILE;

// Procesos ocultos legacy
// 2, 8, 9: Tigo legacy (descartados)
// 1, 3, 4, 5, 6, 7: tabs antiguos (FUTV, TDmas 1, Teletica, Canal 6, Multimedios, Subida)
//   reemplazados por la nueva tecnología (FUTV URL, TDMAS 1 URL, TELETICA URL, CANAL 6 URL, FUTV ALTERNO).
// 15 (CANAL 6 URL): descartado por petición del usuario.
// 19 (RANDOM Disney 7): funcionalidad migrada al tab Disney 7 (ID 0).
//   La lógica permanece en el código por si se necesita revertir; solo se ocultan los tabs.
// 12 (TIGO SRT): descartado — Tigo HDCP bloquea Cam Link 4K (memoria del proyecto).
const HIDDEN_PROCESSES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 19]);
// Procesos que emiten HLS local (sin RTMP)
// ID 0 (Disney 7) ahora emite HLS al slug 'Disney7' (igual que RANDOM Disney 7).
// Disney 8 (ID 10) NO está aquí: usa RTMP destino manual pegado por el usuario.
const HLS_OUTPUT_PROCESSES = new Set([0, FUTV_URL_INDEX, TIGO_URL_INDEX, TELETICA_URL_INDEX, TDMAS1_URL_INDEX, CANAL6_URL_INDEX, DISNEY7_URL_INDEX, FUTV_ALTERNO_INDEX, FUTV_SRT_INDEX, RANDOM_DISNEY7_INDEX, CANAL6_SRT_INDEX, TELETICA_SRT_INDEX, FOXMAS_SRT_INDEX, FOX_SRT_INDEX, FOXMAS_URL_INDEX, FOX_URL_INDEX, FOXMAS_ALTERNO_INDEX, CANAL8_URL_INDEX, CANAL2_URL_INDEX]);
// Procesos que reciben SRT desde OBS (entrada manual interna)
const OBS_INGEST_PROCESSES = new Set<number>([TIGO_URL_INDEX, DISNEY7_URL_INDEX, FUTV_SRT_INDEX, CANAL6_SRT_INDEX, TELETICA_SRT_INDEX, FOXMAS_SRT_INDEX, FOX_SRT_INDEX]);
// Procesos eventuales que aceptan URL pegada del usuario y necesitan scraping dinámico
const PASTE_URL_PROCESSES = new Set<number>([FUTV_ALTERNO_INDEX, FOXMAS_ALTERNO_INDEX]);
// Procesos que reciben un archivo M3U con headers + URL (passthrough -c copy)
// Disney 7 (0) → emite a HLS slug 'Disney7'.
// Disney 8 (10) → emite a RTMP destino manual pegado por el usuario.
// RANDOM Disney 7 (19) → legacy, oculto pero conservado por compatibilidad.
const M3U_FILE_PROCESSES = new Set<number>([0, DISNEY8_INDEX, RANDOM_DISNEY7_INDEX]);
// Procesos que comparten la salida HLS /live/Disney7/playlist.m3u8
// → mutuamente excluyentes (solo uno activo a la vez).
const DISNEY7_SHARED_OUTPUT = [0, DISNEY7_URL_INDEX, RANDOM_DISNEY7_INDEX];
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

interface LiveStats {
  bitrateKbps?: number;
  fps?: number;
  frame?: number;
  speed?: number;
  drop?: number;
  dup?: number;
  q?: number;
  srtRttMs?: number;
  srtBwMbps?: number;
  srtPktsLost?: number;
  updatedAt?: number;
}

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
  { name: "CANAL 6 URL", scrapeFn: "scrape-channel", channelId: "65d7aca4e4b0140cbf380bd0", fetchLabel: "🏛️ Repretel 6 (TDMax)" },
  { name: "DISNEY 7 SRT", scrapeFn: null, channelId: null, fetchLabel: "", presetUrl: SRT_INTERNAL_SOURCE_URL },
  { name: "FUTV ALTERNO", scrapeFn: "scrape-channel", channelId: null, fetchLabel: "🔄 Extraer de URL" },
  { name: "FUTV SRT", scrapeFn: null, channelId: null, fetchLabel: "", presetUrl: SRT_INTERNAL_SOURCE_URL },
  { name: "RANDOM Disney 7", scrapeFn: null, channelId: null, fetchLabel: "" },
  { name: "Canal 6 SRT", scrapeFn: null, channelId: null, fetchLabel: "", presetUrl: SRT_INTERNAL_SOURCE_URL },
  { name: "Teletica SRT", scrapeFn: null, channelId: null, fetchLabel: "", presetUrl: SRT_INTERNAL_SOURCE_URL },
  { name: "FOX+ SRT", scrapeFn: null, channelId: null, fetchLabel: "", presetUrl: SRT_INTERNAL_SOURCE_URL },
  { name: "FOX SRT", scrapeFn: null, channelId: null, fetchLabel: "", presetUrl: SRT_INTERNAL_SOURCE_URL },
  { name: "FOX+ URL", scrapeFn: "scrape-channel", channelId: "6a10a6a2350cb5151ab6ca8c", fetchLabel: "🔄 FOX+" },
  { name: "FOX URL", scrapeFn: "scrape-channel", channelId: "664237788f085ac1f2a15f81", fetchLabel: "🔄 FOX" },
  { name: "FOX+ ALTERNO", scrapeFn: "scrape-channel", channelId: null, fetchLabel: "🔄 Extraer de URL" },
  { name: "Canal 8 URL", scrapeFn: null, channelId: null, fetchLabel: "📡 Telecable" },
  { name: "Canal 2 URL", scrapeFn: null, channelId: null, fetchLabel: "📡 Telecable" },
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
  
  // Siempre arrancar en el primer tab al refrescar para evitar caer en un SRT
  // que se auto-inició (always-on/recovery). El tab solo cambia con click manual.
  const [activeTab, setActiveTab] = useState("0");
  const [isLoading, setIsLoading] = useState(true);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const wsRef = useRef<WebSocket | null>(null);
  
  const [processes, setProcesses] = useState<EmissionProcess[]>(
    Array.from({ length: NUM_PROCESSES }, defaultProcess)
  );

  // Live stats por proceso (bitrate, fps, drops, RTT SRT...) — alimentado por /api/status
  const [liveStats, setLiveStats] = useState<Record<string, LiveStats>>({});

  const reconcileWithServerStatus = useCallback(async () => {
    try {
      const resp = await fetch('/api/status');
      if (!resp.ok) return;

      const data = await resp.json();
      const serverProcesses = data?.processes as Record<string, { status?: string; process_running?: boolean; live?: LiveStats | null }> | undefined;
      if (!serverProcesses) return;

      // Sincronizar live stats (telemetría en vivo) — usado por el tab Uptime
      const nextLive: Record<string, LiveStats> = {};
      for (const [id, st] of Object.entries(serverProcesses)) {
        if (st && st.live) nextLive[id] = st.live;
      }
      setLiveStats(nextLive);

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
  // (Removido) persistencia de activeTab en sessionStorage — evita que un refresh
  // restaure un tab de SRT auto-iniciado.

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

          // Hidrata el selector "Formato de salida" desde la DB para que
          // se vea el mismo perfil que el servidor está usando realmente,
          // sin depender del sessionStorage del navegador (que es por
          // dispositivo y queda desincronizado entre móvil y desktop).
          const profilesFromDb: Record<number, OutputProfile> = {};
          for (const row of data) {
            const raw = (row as unknown as { output_profile?: string }).output_profile;
            if (raw === 'normal' || raw === 'balanced' || raw === 'optimized' || raw === 'passthrough') {
              profilesFromDb[row.id] = raw;
            }
          }
          if (Object.keys(profilesFromDb).length > 0) {
            setOutputProfiles((prev) => ({ ...prev, ...profilesFromDb }));
          }

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
            // Mantén el selector "Formato de salida" en sync con la DB
            // en tiempo real (cuando se cambia desde otro dispositivo).
            const rawProfile = (row as unknown as { output_profile?: string }).output_profile;
            if (
              (rawProfile === 'normal' || rawProfile === 'balanced' || rawProfile === 'optimized' || rawProfile === 'passthrough') &&
              row.id >= 0 && row.id < NUM_PROCESSES
            ) {
              // Si el usuario cambió el perfil localmente hace <PROFILE_WRITE_GUARD_MS,
              // ignoramos el realtime para evitar flicker (el row puede traer el
              // valor viejo si el UPDATE no fue causado por output_profile).
              const lastLocal = pendingProfileWritesRef.current[row.id] || 0;
              const fresh = Date.now() - lastLocal < PROFILE_WRITE_GUARD_MS;
              if (!fresh) {
                setOutputProfiles((prev) =>
                  prev[row.id] === rawProfile ? prev : { ...prev, [row.id]: rawProfile },
                );
              }
            }
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
  // TELETICA URL (13): modo fuente. 'official' = URL directa Bradmax CDN
  // (sin token); 'scraping' = TDMax. Default scraping (comportamiento histórico).
  // Persistido en localStorage. El server flipa oficial→scraping si falla.
  const TELETICA_OFFICIAL_M3U8 = 'https://cdn01.teletica.com/TeleticaLiveStream/Stream/playlist_dvr.m3u8';
  const [teleticaMode, setTeleticaMode] = useState<'official' | 'scraping'>(() => {
    try {
      const v = localStorage.getItem('teletica13_source_mode');
      return v === 'official' ? 'official' : 'scraping';
    } catch {
      return 'scraping';
    }
  });
  useEffect(() => {
    try { localStorage.setItem('teletica13_source_mode', teleticaMode); } catch {}
    if (teleticaMode === 'official') {
      // Auto-rellenar el input M3U8 del proceso 13 con la URL fija.
      setProcesses(prev => {
        const next = [...prev];
        if (next[TELETICA_URL_INDEX] && next[TELETICA_URL_INDEX].m3u8 !== TELETICA_OFFICIAL_M3U8) {
          next[TELETICA_URL_INDEX] = { ...next[TELETICA_URL_INDEX], m3u8: TELETICA_OFFICIAL_M3U8 };
          return next;
        }
        return prev;
      });
    }
  }, [teleticaMode]);
  // Poll del modo en el server (refleja fallbacks automáticos oficial→scraping).
  useEffect(() => {
    let lastServerMode: 'official' | 'scraping' | null = null;
    const interval = setInterval(async () => {
      try {
        const r = await fetch('/api/teletica/source-mode');
        if (!r.ok) return;
        const { mode } = await r.json();
        if (mode !== 'official' && mode !== 'scraping') return;
        // Primera lectura: solo memorizar el valor del server, NO sobrescribir
        // la selección local del usuario (que vive en localStorage).
        if (lastServerMode === null) {
          lastServerMode = mode;
          return;
        }
        // Aplicar solo si el server cambió de valor desde la última lectura
        // (ej: fallback automático oficial→scraping durante recovery).
        if (mode !== lastServerMode) {
          lastServerMode = mode;
          setTeleticaMode(prev => (prev !== mode ? mode : prev));
        }
      } catch {}
    }, 5000);
    return () => clearInterval(interval);
  }, []);
  // ── CANAL 6 URL (15): toggle Oficial / Scraping (espejo de Teletica).
  //    'official' = usuario pega URL libre (no auto-rellena).
  //    'scraping' = flujo TDMax actual.
  const [canal6Mode, setCanal6Mode] = useState<'official' | 'scraping'>(() => {
    try {
      const v = localStorage.getItem('canal6_15_source_mode');
      return v === 'official' ? 'official' : 'scraping';
    } catch {
      return 'scraping';
    }
  });
  useEffect(() => {
    try { localStorage.setItem('canal6_15_source_mode', canal6Mode); } catch {}
  }, [canal6Mode]);
  useEffect(() => {
    let lastServerMode: 'official' | 'scraping' | null = null;
    const interval = setInterval(async () => {
      try {
        const r = await fetch('/api/canal6/source-mode');
        if (!r.ok) return;
        const { mode } = await r.json();
        if (mode !== 'official' && mode !== 'scraping') return;
        if (lastServerMode === null) { lastServerMode = mode; return; }
        if (mode !== lastServerMode) {
          lastServerMode = mode;
          setCanal6Mode(prev => (prev !== mode ? mode : prev));
        }
      } catch {}
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // ── TELECABLE: modo alterno por pid (FUTV/Teletica/TDMas1/Canal6/FOX+/FOX).
  //    'telecable' = login directo a la API de Telecable desde el VPS (sin túnel CR).
  //    'scraping'  = flujo histórico del canal (TDMax+Pi5 o lo que aplique).
  // pid 0 (Disney 7) usa selector dedicado "Oficial | Telecable" con dropdown.
  // pids 27/28 (Canal 8 / Canal 2 URL) son TELECABLE-only (sin toggle).
  const TELECABLE_PIDS = useMemo(() => new Set<number>([0, 11, 13, 14, 15, 24, 25, 27, 28]), []);
  // pids cuyo único modo permitido es TELECABLE (sin selector visible).
  const TELECABLE_ONLY_PIDS = useMemo(() => new Set<number>([27, 28]), []);
  type TelecableMode = 'scraping' | 'telecable';
  type TelecableInfo = { expires_at: number | null; expires_in_s: number | null; last_login_failure_count: number } | null;
  const [telecableModes, setTelecableModes] = useState<Record<number, TelecableMode>>(() => {
    const init: Record<number, TelecableMode> = {};
    for (const pid of [0, 11, 13, 14, 15, 24, 25, 27, 28]) {
      try {
        const v = localStorage.getItem(`telecable_${pid}_source_mode`);
        // Canal 8 / Canal 2 son telecable-only.
        const forceTelecable = pid === 27 || pid === 28;
        init[pid] = (forceTelecable || v === 'telecable') ? 'telecable' : 'scraping';
      } catch { init[pid] = 'scraping'; }
    }
    return init;
  });
  const [telecableInfos, setTelecableInfos] = useState<Record<number, TelecableInfo>>({});
  const handleTelecableModeChange = useCallback((pid: number, mode: TelecableMode) => {
    setTelecableModes(prev => ({ ...prev, [pid]: mode }));
    try { localStorage.setItem(`telecable_${pid}_source_mode`, mode); } catch {}
    void fetch(`/api/telecable/${pid}/source-mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    }).catch(() => {});
  }, []);
  // Compat alias para el resto del archivo que aún refiere foxMode (pid 25).
  const foxMode = telecableModes[25] || 'scraping';
  const handleFoxModeChange = useCallback((mode: TelecableMode) => handleTelecableModeChange(25, mode), [handleTelecableModeChange]);
  const foxTelecableInfo = telecableInfos[25] || null;
  // Poll por pid del estado real en el servidor.
  useEffect(() => {
    const lastSeen: Record<number, TelecableMode | null> = {};
    const tick = async () => {
      await Promise.all(Array.from(TELECABLE_PIDS).map(async (pid) => {
        try {
          const r = await fetch(`/api/telecable/${pid}/source-mode`);
          if (!r.ok) return;
          const j = await r.json();
          if (j.mode === 'telecable' || j.mode === 'scraping') {
            if (lastSeen[pid] === undefined) lastSeen[pid] = j.mode;
            else if (j.mode !== lastSeen[pid]) {
              lastSeen[pid] = j.mode;
              setTelecableModes(prev => (prev[pid] !== j.mode ? { ...prev, [pid]: j.mode } : prev));
            }
          }
          setTelecableInfos(prev => ({
            ...prev,
            [pid]: {
              expires_at: j.telecable?.expires_at ?? null,
              expires_in_s: j.telecable?.expires_in_s ?? null,
              last_login_failure_count: j.last_login_failure_count ?? 0,
            },
          }));
        } catch {}
      }));
    };
    tick();
    const interval = setInterval(tick, 5000);
    return () => clearInterval(interval);
  }, [TELECABLE_PIDS]);

  // ── Salida CR vía Pi5 (WireGuard) — set + poll de health del túnel.
  const CR_TUNNEL_CHANNELS = useMemo(() => new Set<number>([15, 24, 25]), []);
  const [crTunnelHealth, setCrTunnelHealth] = useState<{ wg_up: boolean; cr_ip: string | null }>({
    wg_up: false,
    cr_ip: null,
  });
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch('/api/cr-tunnel/health');
        if (!r.ok) return;
        const j = await r.json();
        if (cancelled) return;
        setCrTunnelHealth({ wg_up: !!j.wg_up, cr_ip: typeof j.cr_ip === 'string' ? j.cr_ip : null });
      } catch {}
    };
    tick();
    const interval = setInterval(tick, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);
  const [outputProfiles, setOutputProfiles] = useState<Record<number, OutputProfile>>(() => {
    try {
      const parsed = JSON.parse(sessionStorage.getItem("emisor-output-profiles") || "{}");
      return Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => value === "normal" || value === "balanced" || value === "optimized" || value === "passthrough"),
      ) as Record<number, OutputProfile>;
    } catch {
      return {};
    }
  });
  // URL pegada por el usuario para canales tipo FUTV ALTERNO (eventuales)
  const [pasteUrls, setPasteUrls] = useState<Record<number, string>>({});
  // Payload parseado de archivos M3U subidos (RANDOM Disney 7 y similares)
  interface M3uPayload {
    fileName: string;
    url: string;
    referer?: string;
    userAgent?: string;
    headers: Record<string, string>;
  }
  const [m3uPayloads, setM3uPayloads] = useState<Record<number, M3uPayload>>({});
  // Texto pegado del contenido M3U (RANDOM Disney 7) — alternativa a subir archivo
  const [m3uPasteText, setM3uPasteText] = useState<Record<number, string>>({});

  // ── Disney 7 (pid 0): selector "Oficial | Telecable" + dropdown de canales.
  //    'official' = flujo histórico (archivo M3U pegado, perfil VLC-like).
  //    'telecable' = login Telecable + dropdown de canales (TUDN, ESPN, etc.).
  type Disney7Mode = 'official' | 'telecable';
  const [disney7Mode, setDisney7Mode] = useState<Disney7Mode>(() => {
    try {
      const v = localStorage.getItem('disney7_0_source_mode');
      return v === 'telecable' ? 'telecable' : 'official';
    } catch { return 'official'; }
  });
  useEffect(() => {
    try { localStorage.setItem('disney7_0_source_mode', disney7Mode); } catch {}
    setTelecableModes(prev => ({ ...prev, [0]: disney7Mode === 'telecable' ? 'telecable' : 'scraping' }));
  }, [disney7Mode]);
  type TelecableChannel = { contentId: string; name: string | null };
  const [telecableChannels, setTelecableChannels] = useState<TelecableChannel[]>([]);
  const [telecableChannelsLoading, setTelecableChannelsLoading] = useState(false);
  const [disney7ContentId, setDisney7ContentId] = useState<string>(() => {
    try { return localStorage.getItem('disney7_0_telecable_content_id') || ''; } catch { return ''; }
  });
  useEffect(() => {
    try { localStorage.setItem('disney7_0_telecable_content_id', disney7ContentId); } catch {}
  }, [disney7ContentId]);
  const loadTelecableChannels = useCallback(async (force = false) => {
    setTelecableChannelsLoading(true);
    try {
      const r = await fetch(`/api/telecable/channels${force ? '?force=1' : ''}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (Array.isArray(j.channels)) {
        const list: TelecableChannel[] = j.channels
          .filter((c: any) => c && c.contentId)
          .map((c: any) => ({ contentId: String(c.contentId), name: c.name || c.contentId }));
        list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        setTelecableChannels(list);
      }
    } catch (e: any) {
      toast.error(`No se pudo cargar lista Telecable: ${e?.message || e}`);
    } finally {
      setTelecableChannelsLoading(false);
    }
  }, []);
  // Cargar la lista cuando el usuario entra al tab Disney 7 en modo telecable.
  useEffect(() => {
    if (activeTab === '0' && disney7Mode === 'telecable' && telecableChannels.length === 0 && !telecableChannelsLoading) {
      loadTelecableChannels(false);
    }
  }, [activeTab, disney7Mode, telecableChannels.length, telecableChannelsLoading, loadTelecableChannels]);
  // Modo de salida para procesos M3U file (RANDOM Disney 7).
  // 'copy' = -c copy puro · 'smart' = copy compatible con fallback · 'transcode' = perfil estándar 2000k
  // RANDOM Disney 7 (ID 19) ahora usa un único modo "rawvideo": video crudo
  // (-c:v copy) + audio re-encodeado a AAC 128k/48kHz estéreo. Esto preserva
  // calidad de origen y garantiza audio en Xui / IPTV Smarters Pro.
  const { metricsHistory, latestMetrics } = useServerMetrics();

  useEffect(() => {
    sessionStorage.setItem("emisor-output-profiles", JSON.stringify(outputProfiles));
  }, [outputProfiles]);

  // Marca por pid de "el usuario acaba de cambiar el perfil localmente". Sirve para
  // ignorar updates del realtime/DB que llegan con el valor viejo y producen flicker
  // visual al pulsar Emitir (el realtime UPDATE de is_emitting incluye output_profile
  // del row, que aún no contiene el nuevo valor — se reescribiría el viejo encima).
  const pendingProfileWritesRef = useRef<Record<number, number>>({});
  const PROFILE_WRITE_GUARD_MS = 8000;

  const getOutputProfile = (processIndex: number): OutputProfile =>
    outputProfiles[processIndex] || getDefaultOutputProfile(processIndex);

  const setOutputProfile = (processIndex: number, profile: OutputProfile) => {
    setOutputProfiles((prev) => ({ ...prev, [processIndex]: profile }));
    pendingProfileWritesRef.current[processIndex] = Date.now();
    // Sincroniza el perfil en la DB para que TODOS los dispositivos
    // (móvil, computadora, otra pestaña) vean el mismo valor que
    // realmente está usando el servidor. Sin esto, cada navegador
    // muestra lo que tenga en sessionStorage y puede no coincidir
    // con el perfil real en ejecución.
    void supabase
      .from('emission_processes')
      .update({ output_profile: profile } as never)
      .eq('id', processIndex);
  };

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

  // ───────────────────────────────────────────────────────────────────────
  // Parser de archivo M3U (RANDOM Disney 7 / ID 19)
  //   - Soporta `#EXTVLCOPT:http-referrer=...`
  //   - Soporta `#EXTVLCOPT:http-user-agent=...`
  //   - Soporta `#EXTVLCOPT:http-header=Key:Value` (múltiples)
  //   - Toma la PRIMERA línea no-comentario como URL del stream
  // Devuelve null si no se encuentra una URL válida.
  // ───────────────────────────────────────────────────────────────────────
  const parseM3uContent = (content: string): Omit<M3uPayload, 'fileName'> | null => {
    if (!content) return null;
    const lines = content.split(/\r?\n/);
    let url = '';
    let referer: string | undefined;
    let userAgent: string | undefined;
    const headers: Record<string, string> = {};

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('#EXTVLCOPT:')) {
        const opt = line.slice('#EXTVLCOPT:'.length);
        const eqIdx = opt.indexOf('=');
        if (eqIdx === -1) continue;
        const key = opt.slice(0, eqIdx).trim().toLowerCase();
        const value = opt.slice(eqIdx + 1).trim();
        if (key === 'http-referrer' || key === 'http-referer') {
          referer = value;
        } else if (key === 'http-user-agent') {
          userAgent = value;
        } else if (key === 'http-header') {
          // Formato: "Key:Value" (puede haber `:` extra dentro del value)
          const colonIdx = value.indexOf(':');
          if (colonIdx > 0) {
            const hk = value.slice(0, colonIdx).trim();
            const hv = value.slice(colonIdx + 1).trim();
            if (hk && hv) headers[hk] = hv;
          }
        }
        continue;
      }

      // Líneas de comentario / metadata las ignoramos
      if (line.startsWith('#')) continue;

      // Primera línea no-comentario = URL del stream
      if (!url && /^https?:\/\//i.test(line)) {
        url = line;
        break; // Solo el primer canal del M3U
      }
    }

    if (!url) return null;
    return { url, referer, userAgent, headers };
  };

  const handleM3uFile = async (processIndex: number, file: File) => {
    try {
      if (file.size > 1024 * 1024) {
        toast.error('Archivo demasiado grande (>1MB)');
        return;
      }
      const text = await file.text();
      const parsed = parseM3uContent(text);
      if (!parsed) {
        toast.error('No se encontró una URL válida en el archivo M3U');
        return;
      }
      const payload: M3uPayload = { fileName: file.name, ...parsed };
      setM3uPayloads(prev => ({ ...prev, [processIndex]: payload }));
      // Reflejar la URL en el campo m3u8 del proceso para mantener compatibilidad
      updateProcess(processIndex, { m3u8: parsed.url });
      const headerCount = Object.keys(parsed.headers).length;
      toast.success(
        `M3U cargado: ${file.name}` +
        (parsed.referer ? ` · referer ✓` : '') +
        (parsed.userAgent ? ` · UA ✓` : '') +
        (headerCount > 0 ? ` · ${headerCount} header(s)` : '')
      );
    } catch (e) {
      console.error('Error leyendo M3U:', e);
      toast.error('No se pudo leer el archivo M3U');
    }
  };

  // Procesa texto M3U pegado directamente (sin archivo)
  const handleM3uPaste = (processIndex: number) => {
    const text = (m3uPasteText[processIndex] || '').trim();
    if (!text) {
      toast.error('Pega el contenido del M3U primero');
      return;
    }
    if (text.length > 1024 * 1024) {
      toast.error('Texto demasiado grande (>1MB)');
      return;
    }
    const parsed = parseM3uContent(text);
    if (!parsed) {
      toast.error('No se encontró una URL válida en el texto pegado');
      return;
    }
    const payload: M3uPayload = { fileName: 'pegado.m3u', ...parsed };
    setM3uPayloads(prev => ({ ...prev, [processIndex]: payload }));
    updateProcess(processIndex, { m3u8: parsed.url });
    const headerCount = Object.keys(parsed.headers).length;
    toast.success(
      `M3U procesado` +
      (parsed.referer ? ` · referer ✓` : '') +
      (parsed.userAgent ? ` · UA ✓` : '') +
      (headerCount > 0 ? ` · ${headerCount} header(s)` : '')
    );
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
      const data = await scrapeChannelWithFallback(channelId, processIndex, pasted);
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
      // Usar scraping LOCAL del VPS (token con IP correcta) y caer a
      // edge function si /api/local-scrape no está disponible (preview).
      const data = await scrapeChannelWithFallback(channelId, processIndex);
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
    const canal6SrtPreset = CHANNEL_CONFIGS[CANAL6_SRT_INDEX]?.presetUrl;
    const teleticaSrtPreset = CHANNEL_CONFIGS[TELETICA_SRT_INDEX]?.presetUrl;
    const foxmasSrtPreset = CHANNEL_CONFIGS[FOXMAS_SRT_INDEX]?.presetUrl;
    const foxSrtPreset = CHANNEL_CONFIGS[FOX_SRT_INDEX]?.presetUrl;
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

      if (canal6SrtPreset && (next[CANAL6_SRT_INDEX]?.m3u8 !== canal6SrtPreset || next[CANAL6_SRT_INDEX]?.rtmp !== tigoRtmp)) {
        next[CANAL6_SRT_INDEX] = { ...next[CANAL6_SRT_INDEX], m3u8: canal6SrtPreset, rtmp: tigoRtmp };
        changed = true;
      }

      if (teleticaSrtPreset && (next[TELETICA_SRT_INDEX]?.m3u8 !== teleticaSrtPreset || next[TELETICA_SRT_INDEX]?.rtmp !== tigoRtmp)) {
        next[TELETICA_SRT_INDEX] = { ...next[TELETICA_SRT_INDEX], m3u8: teleticaSrtPreset, rtmp: tigoRtmp };
        changed = true;
      }

      if (foxmasSrtPreset && (next[FOXMAS_SRT_INDEX]?.m3u8 !== foxmasSrtPreset || next[FOXMAS_SRT_INDEX]?.rtmp !== tigoRtmp)) {
        next[FOXMAS_SRT_INDEX] = { ...next[FOXMAS_SRT_INDEX], m3u8: foxmasSrtPreset, rtmp: tigoRtmp };
        changed = true;
      }

      if (foxSrtPreset && (next[FOX_SRT_INDEX]?.m3u8 !== foxSrtPreset || next[FOX_SRT_INDEX]?.rtmp !== tigoRtmp)) {
        next[FOX_SRT_INDEX] = { ...next[FOX_SRT_INDEX], m3u8: foxSrtPreset, rtmp: tigoRtmp };
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

    if (canal6SrtPreset) {
      supabase
        .from('emission_processes')
        .update({ m3u8: canal6SrtPreset, rtmp: tigoRtmp })
        .eq('id', CANAL6_SRT_INDEX)
        .then(({ error }) => {
          if (error) console.error('Error guardando preset de CANAL 6 SRT:', error);
        });
    }

    if (teleticaSrtPreset) {
      supabase
        .from('emission_processes')
        .update({ m3u8: teleticaSrtPreset, rtmp: tigoRtmp })
        .eq('id', TELETICA_SRT_INDEX)
        .then(({ error }) => {
          if (error) console.error('Error guardando preset de TELETICA SRT:', error);
        });
    }

    if (foxmasSrtPreset) {
      supabase
        .from('emission_processes')
        .update({ m3u8: foxmasSrtPreset, rtmp: tigoRtmp })
        .eq('id', FOXMAS_SRT_INDEX)
        .then(({ error }) => {
          if (error) console.error('Error guardando preset de FOX+ SRT:', error);
        });
    }

    if (foxSrtPreset) {
      supabase
        .from('emission_processes')
        .update({ m3u8: foxSrtPreset, rtmp: tigoRtmp })
        .eq('id', FOX_SRT_INDEX)
        .then(({ error }) => {
          if (error) console.error('Error guardando preset de FOX SRT:', error);
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
    const selectedProfile = getOutputProfile(processIndex);
    
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
        formData.append('output_profile', selectedProfile);
        
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
    // Disney 7 (pid 0) en modo Telecable NO usa archivo M3U — usa contentId del dropdown.
    const isDisney7Telecable = processIndex === 0 && disney7Mode === 'telecable';
    const isM3uFileProcess = M3U_FILE_PROCESSES.has(processIndex) && !isDisney7Telecable;
    const m3uPayload = isM3uFileProcess ? m3uPayloads[processIndex] : null;

    // Disney 7 Telecable: validar que el usuario eligió un canal del dropdown
    if (isDisney7Telecable && !disney7ContentId) {
      updateProcess(processIndex, {
        emitStatus: "error",
        emitMsg: "Seleccioná un canal del dropdown Telecable primero",
      });
      return;
    }

    // RANDOM Disney 7 (19) requiere que se haya cargado un archivo M3U
    if (isM3uFileProcess && !m3uPayload) {
      updateProcess(processIndex, {
        emitStatus: "error",
        emitMsg: "Sube un archivo M3U primero"
      });
      return;
    }

    // Mutex entre todos los procesos que comparten /live/Disney7/playlist.m3u8
    // (Disney 7 ID 0, DISNEY 7 SRT ID 16, RANDOM Disney 7 ID 19).
    if (DISNEY7_SHARED_OUTPUT.includes(processIndex)) {
      for (const otherIdx of DISNEY7_SHARED_OUTPUT) {
        if (otherIdx === processIndex) continue;
        if (processes[otherIdx]?.isEmitiendo) {
          toast.info(`Deteniendo ${CHANNEL_CONFIGS[otherIdx].name} (comparten salida Disney7)...`);
          try {
            await fetch("/api/emit/stop", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ process_id: otherIdx.toString() })
            });
          } catch (e) {
            console.warn(`No se pudo detener proceso ${otherIdx}:`, e);
          }
        }
      }
    }

    // Mutex CANAL 6 URL (15) ↔ CANAL 6 SRT (20): comparten /live/Canal6/playlist.m3u8.
    if (processIndex === CANAL6_URL_INDEX || processIndex === CANAL6_SRT_INDEX) {
      const otherIdx = processIndex === CANAL6_URL_INDEX ? CANAL6_SRT_INDEX : CANAL6_URL_INDEX;
      if (processes[otherIdx]?.isEmitiendo) {
        toast.info(`Deteniendo ${CHANNEL_CONFIGS[otherIdx].name} (comparten salida Canal6)...`);
        try {
          await fetch("/api/emit/stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ process_id: otherIdx.toString() })
          });
        } catch (e) {
          console.warn(`No se pudo detener proceso ${otherIdx}:`, e);
        }
      }
    }

    // Mutex TELETICA URL (13) ↔ TELETICA SRT (21): comparten /live/Teletica/playlist.m3u8.
    if (processIndex === TELETICA_URL_INDEX || processIndex === TELETICA_SRT_INDEX) {
      const otherIdx = processIndex === TELETICA_URL_INDEX ? TELETICA_SRT_INDEX : TELETICA_URL_INDEX;
      if (processes[otherIdx]?.isEmitiendo) {
        toast.info(`Deteniendo ${CHANNEL_CONFIGS[otherIdx].name} (comparten salida Teletica)...`);
        try {
          await fetch("/api/emit/stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ process_id: otherIdx.toString() })
          });
        } catch (e) {
          console.warn(`No se pudo detener proceso ${otherIdx}:`, e);
        }
      }
    }

    // Mutex FOX+ URL (24) ↔ FOX+ SRT (22): comparten /live/foxmas/playlist.m3u8.
    // Mutex FOX+: URL (24) ↔ SRT (22) ↔ ALTERNO (26) — los 3 comparten /live/foxmas/playlist.m3u8.
    if (processIndex === FOXMAS_URL_INDEX || processIndex === FOXMAS_SRT_INDEX || processIndex === FOXMAS_ALTERNO_INDEX) {
      const foxmasGroup = [FOXMAS_URL_INDEX, FOXMAS_SRT_INDEX, FOXMAS_ALTERNO_INDEX];
      for (const otherIdx of foxmasGroup) {
        if (otherIdx === processIndex) continue;
        if (processes[otherIdx]?.isEmitiendo) {
          toast.info(`Deteniendo ${CHANNEL_CONFIGS[otherIdx].name} (comparten salida FOX+)...`);
          try {
            await fetch("/api/emit/stop", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ process_id: otherIdx.toString() })
            });
          } catch (e) {
            console.warn(`No se pudo detener proceso ${otherIdx}:`, e);
          }
        }
      }
    }

    // Mutex FOX URL (25) ↔ FOX SRT (23): comparten /live/fox/playlist.m3u8.
    if (processIndex === FOX_URL_INDEX || processIndex === FOX_SRT_INDEX) {
      const otherIdx = processIndex === FOX_URL_INDEX ? FOX_SRT_INDEX : FOX_URL_INDEX;
      if (processes[otherIdx]?.isEmitiendo) {
        toast.info(`Deteniendo ${CHANNEL_CONFIGS[otherIdx].name} (comparten salida FOX)...`);
        try {
          await fetch("/api/emit/stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ process_id: otherIdx.toString() })
          });
        } catch (e) {
          console.warn(`No se pudo detener proceso ${otherIdx}:`, e);
        }
      }
    }

    // En Disney 7 Telecable y en TELECABLE-only pids (Canal 8/2), el `m3u8`
    // del input puede estar vacío — la URL la resuelve el backend.
    const requiresM3u8Input = !isDisney7Telecable && !TELECABLE_ONLY_PIDS.has(processIndex);
    if ((requiresM3u8Input && !process.m3u8) || (!process.rtmp && !isHlsOutput)) {
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
          source_m3u8: process.m3u8 || '',
          target_rtmp: isHlsOutput ? 'hls-local' : process.rtmp,
          process_id: processIndex.toString(),
          output_profile: selectedProfile,
          // Telecable gana sobre el modo histórico cuando está activo. Para
          // los pids no-Telecable, se mantiene la lógica original (teletica/canal6).
          ...(TELECABLE_PIDS.has(processIndex) && telecableModes[processIndex] === 'telecable'
            ? {
                source_mode: 'telecable' as const,
                ...(processIndex === 0 && disney7ContentId ? { telecable_content_id: disney7ContentId } : {}),
              }
            : processIndex === 0 ? { source_mode: 'scraping' as const }
            : processIndex === TELETICA_URL_INDEX ? { source_mode: teleticaMode }
            : processIndex === CANAL6_URL_INDEX ? { source_mode: canal6Mode }
            : processIndex === FOX_URL_INDEX ? { source_mode: foxMode }
            : {}),
          ...(isM3uFileProcess && m3uPayload ? {
            // passthrough_mode: 'transcode' → usa el perfil estándar 720p CBR 2000k
            // (mismo que Disney 7 ID 0). Resuelve el "video crudo no va bien" en Xui/IPTV.
            passthrough: false,
            passthrough_mode: 'transcode',
            referer: m3uPayload.referer || null,
            user_agent: m3uPayload.userAgent || null,
            extra_headers: m3uPayload.headers || {},
          } : {}),
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
          emit_status: 'running',
          // Persistir también el perfil para que el selector quede
          // coherente con lo que el servidor está emitiendo realmente.
          output_profile: selectedProfile,
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
          output_profile: getOutputProfile(processIndex),
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
      { bg: "bg-violet-500", text: "text-violet-500", stroke: "#8b5cf6", name: "RANDOM Disney 7" },
      { bg: "bg-orange-600", text: "text-orange-500", stroke: "#ea580c", name: "Canal 6 SRT" },
      { bg: "bg-cyan-600", text: "text-cyan-400", stroke: "#0891b2", name: "Teletica SRT" },
      { bg: "bg-red-500", text: "text-red-400", stroke: "#ef4444", name: "FOX+ SRT" },
      { bg: "bg-red-700", text: "text-red-500", stroke: "#b91c1c", name: "FOX SRT" },
      { bg: "bg-red-600", text: "text-red-500", stroke: "#dc2626", name: "FOX+ URL" },
      { bg: "bg-red-800", text: "text-red-400", stroke: "#991b1b", name: "FOX URL" },
      { bg: "bg-rose-700", text: "text-rose-400", stroke: "#be123c", name: "FOX+ ALTERNO" },
      { bg: "bg-orange-400", text: "text-orange-300", stroke: "#fb923c", name: "Canal 8 URL" },
      { bg: "bg-sky-600", text: "text-sky-400", stroke: "#0284c7", name: "Canal 2 URL" },
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
    const outputProfile = getOutputProfile(processIndex);
    const isDisney7Tab = processIndex === 0;
    const isDisney7TelecableActive = isDisney7Tab && disney7Mode === 'telecable';
    const isTelecableOnlyTab = TELECABLE_ONLY_PIDS.has(processIndex);
    // Pids cuya UI de input m3u8 NO se muestra (URL resuelta por backend).
    const hideM3u8Input = isDisney7TelecableActive || isTelecableOnlyTab;

    return (
      <div className="space-y-6">
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Panel de configuración */}
          <div className="bg-broadcast-panel/60 backdrop-blur-sm rounded-2xl p-5 shadow-lg border border-broadcast-border/50 transition-all duration-300 hover:shadow-xl">
            <h2 className="text-lg font-medium mb-4 text-accent">
              {processIndex === FILE_UPLOAD_INDEX ? "Archivos Locales" : "Fuente y Cabeceras"} - {channelConfig.name}
            </h2>
            {CR_TUNNEL_CHANNELS.has(processIndex) && !(TELECABLE_PIDS.has(processIndex) && telecableModes[processIndex] === 'telecable') && (
              <div className="mb-4 -mt-2">
                {crTunnelHealth.wg_up && crTunnelHealth.cr_ip ? (
                  <span
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold border bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                    title={`Este canal sale al CDN desde Costa Rica vía Pi5 (10.77.0.1). IP pública vista: ${crTunnelHealth.cr_ip}`}
                  >
                    🇨🇷 IP CR · <span className="font-mono">{crTunnelHealth.cr_ip}</span>
                    {process.isEmitiendo && <span className="ml-1 opacity-80">• EMITIENDO</span>}
                  </span>
                ) : (
                  <span
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold border bg-amber-500/15 border-amber-500/40 text-amber-300"
                    title="El túnel WireGuard al Pi5 (CR) no está activo. Este canal va a fallar al arrancar hasta que el túnel se restablezca."
                  >
                    ⚠️ Túnel CR caído
                  </span>
                )}
              </div>
            )}

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
                  {M3U_FILE_PROCESSES.has(processIndex)
                    ? 'Archivo M3U (con headers)'
                    : OBS_INGEST_PROCESSES.has(processIndex)
                    ? 'Entrada SRT (OBS)'
                    : PASTE_URL_PROCESSES.has(processIndex)
                      ? 'URL del player TDMax (pega aquí)'
                      : 'URL M3U8 (fuente)'}
                </label>
                {M3U_FILE_PROCESSES.has(processIndex) && (
                  <div className="mb-3">
                    <textarea
                      placeholder={"#EXTM3U\n#EXTVLCOPT:http-referrer=https://...\n#EXTVLCOPT:http-user-agent=Mozilla/5.0 ...\n#EXTINF:-1,Canal\nhttps://servidor.com/stream.m3u8"}
                      value={m3uPasteText[processIndex] || ''}
                      onChange={(e) => setM3uPasteText(prev => ({ ...prev, [processIndex]: e.target.value }))}
                      rows={6}
                      className="w-full bg-card border border-border rounded-xl px-4 py-3 mb-2 outline-none focus:ring-2 focus:ring-violet-400/50 transition-all duration-200 font-mono text-xs resize-y"
                    />
                    <div className="flex gap-2 mb-2">
                      <button
                        type="button"
                        onClick={() => handleM3uPaste(processIndex)}
                        className="flex-1 px-4 py-2 rounded-xl bg-violet-500 hover:bg-violet-600 text-white text-sm font-medium transition-colors"
                      >
                        📋 Procesar M3U pegado
                      </button>
                      <label className="px-4 py-2 rounded-xl bg-card border border-border hover:bg-muted text-sm font-medium cursor-pointer transition-colors">
                        📂 Archivo
                        <input
                          type="file"
                          accept=".m3u,.m3u8,audio/x-mpegurl,application/vnd.apple.mpegurl"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) handleM3uFile(processIndex, f);
                            e.target.value = '';
                          }}
                          className="hidden"
                        />
                      </label>
                    </div>
                    {m3uPayloads[processIndex] && (
                      <div className="p-3 rounded-xl bg-card/50 border border-violet-400/30 space-y-1.5">
                        <p className="text-xs text-muted-foreground">
                          📄 <span className="text-foreground font-medium">{m3uPayloads[processIndex].fileName}</span>
                        </p>
                        <p className="text-xs text-muted-foreground break-all">
                          🔗 <span className="text-foreground font-mono">{m3uPayloads[processIndex].url}</span>
                        </p>
                        {m3uPayloads[processIndex].referer && (
                          <p className="text-xs text-muted-foreground">
                            🧾 referer: <span className="text-foreground">{m3uPayloads[processIndex].referer}</span>
                          </p>
                        )}
                        {m3uPayloads[processIndex].userAgent && (
                          <p className="text-xs text-muted-foreground">
                            🧾 user-agent: <span className="text-foreground">{m3uPayloads[processIndex].userAgent.substring(0, 80)}{m3uPayloads[processIndex].userAgent.length > 80 ? '…' : ''}</span>
                          </p>
                        )}
                        {Object.keys(m3uPayloads[processIndex].headers).length > 0 && (
                          <p className="text-xs text-muted-foreground">
                            🧾 headers extra: <span className="text-foreground">{Object.keys(m3uPayloads[processIndex].headers).length}</span>
                          </p>
                        )}
                      </div>
                    )}
                    {/* Modo de salida: transcode compatible Xui/Smarters */}
                    <div className="mt-3 p-3 rounded-xl bg-card/50 border border-violet-400/20">
                      <p className="text-xs text-violet-300 font-medium mb-1">
                        🎬 Modo: <span className="text-violet-100">TRANSCODE según formato de salida</span>
                      </p>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        Mismo perfil que Disney 7 (ID 0): input HLS resiliente VLC-like
                        (<code className="text-violet-400">max_reload=1000</code>, <code className="text-violet-400">-re</code>) +
                         re-encode a <strong className="text-violet-200">{OUTPUT_PROFILE_LABELS[outputProfile]}</strong>
                         {outputProfile === 'normal' ? ' (preset veryfast, GOP 2s)' : ' (preset faster + x264-params, GOP 2s)'}.
                         Garantiza compatibilidad y estabilidad en Xui / IPTV Smarters Pro.
                      </p>
                    </div>
                  </div>
                )}
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
                {!M3U_FILE_PROCESSES.has(processIndex) && (
                <>
                {processIndex === TELETICA_URL_INDEX && (
                  <div className="mb-3 p-3 rounded-xl bg-card/50 border border-border">
                    <label className="block text-xs mb-2 text-muted-foreground uppercase tracking-wide font-semibold">
                      Fuente Teletica
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setTeleticaMode('official')}
                        disabled={process.isEmitiendo || process.emitStatus === 'starting'}
                        className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all border-2 ${
                          teleticaMode === 'official'
                            ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                            : 'bg-background border-border text-muted-foreground hover:border-emerald-500/40'
                        } disabled:opacity-60 disabled:cursor-not-allowed`}
                        title="URL directa Bradmax CDN (sin token, sin login)"
                      >
                        🏛️ Oficial (Bradmax)
                      </button>
                      <button
                        type="button"
                        onClick={() => setTeleticaMode('scraping')}
                        disabled={process.isEmitiendo || process.emitStatus === 'starting'}
                        className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all border-2 ${
                          teleticaMode === 'scraping'
                            ? 'bg-blue-500/20 border-blue-500 text-blue-300'
                            : 'bg-background border-border text-muted-foreground hover:border-blue-500/40'
                        } disabled:opacity-60 disabled:cursor-not-allowed`}
                        title="Login TDMax + wmsAuthSign (método histórico)"
                      >
                        🔐 Scraping (TDMax)
                      </button>
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
                      {teleticaMode === 'official'
                        ? 'URL directa de la CDN de Teletica (Referer Bradmax). Si falla, el servidor reintenta hasta 2 veces más con la URL oficial y, si sigue fallando, cambia automáticamente a SCRAPING.'
                        : 'Login TDMax + token de 60s. Si falla, NO promueve a oficial (solo manual).'}
                    </p>
                  </div>
                )}
                {processIndex === CANAL6_URL_INDEX && (
                  <div className="mb-3 p-3 rounded-xl bg-card/50 border border-border">
                    <label className="block text-xs mb-2 text-muted-foreground uppercase tracking-wide font-semibold">
                      Fuente Canal 6
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setCanal6Mode('official')}
                        disabled={process.isEmitiendo || process.emitStatus === 'starting'}
                        className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all border-2 ${
                          canal6Mode === 'official'
                            ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                            : 'bg-background border-border text-muted-foreground hover:border-emerald-500/40'
                        } disabled:opacity-60 disabled:cursor-not-allowed`}
                        title="Pegá tu propia URL (sin scraping). El FFmpeg igual sale por IP CR vía Pi5."
                      >
                        🏛️ Oficial (URL pegada)
                      </button>
                      <button
                        type="button"
                        onClick={() => setCanal6Mode('scraping')}
                        disabled={process.isEmitiendo || process.emitStatus === 'starting'}
                        className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all border-2 ${
                          canal6Mode === 'scraping'
                            ? 'bg-blue-500/20 border-blue-500 text-blue-300'
                            : 'bg-background border-border text-muted-foreground hover:border-blue-500/40'
                        } disabled:opacity-60 disabled:cursor-not-allowed`}
                        title="Login TDMax + token de 60s (flujo histórico)"
                      >
                        🔐 Scraping (TDMax)
                      </button>
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
                      {canal6Mode === 'official'
                        ? 'Usá la URL que pegues en el input. Sin login, sin scraping. El consumo igual sale por IP de Costa Rica vía Pi5.'
                        : 'Scraping TDMax (cuenta info@media.cr) + token de 60s. El servidor renueva automáticamente.'}
                    </p>
                  </div>
                )}
                {TELECABLE_PIDS.has(processIndex) && (() => {
                  const tMode = telecableModes[processIndex] || 'scraping';
                  const tInfo = telecableInfos[processIndex] || null;
                  const isFox = processIndex === FOX_URL_INDEX;
                  const scrapingLabel = isFox ? '🔐 Scraping (TDMax+CR)' : '🔐 Modo histórico';
                  const scrapingHelp = isFox
                    ? 'Scraping TDMax con salida vía IP de Costa Rica (Pi5). Método histórico.'
                    : 'Usa el flujo histórico de este canal (TDMax/scraping, etc).';
                  return (
                    <div className="mb-3 p-3 rounded-xl bg-card/50 border border-border">
                      <label className="block text-xs mb-2 text-muted-foreground uppercase tracking-wide font-semibold">
                        Fuente alterna — Telecable
                      </label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => handleTelecableModeChange(processIndex, 'scraping')}
                          disabled={process.isEmitiendo || process.emitStatus === 'starting'}
                          className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all border-2 ${
                            tMode === 'scraping'
                              ? 'bg-blue-500/20 border-blue-500 text-blue-300'
                              : 'bg-background border-border text-muted-foreground hover:border-blue-500/40'
                          } disabled:opacity-60 disabled:cursor-not-allowed`}
                          title="Usar el modo histórico del canal"
                        >
                          {scrapingLabel}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleTelecableModeChange(processIndex, 'telecable')}
                          disabled={process.isEmitiendo || process.emitStatus === 'starting'}
                          className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all border-2 ${
                            tMode === 'telecable'
                              ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                              : 'bg-background border-border text-muted-foreground hover:border-amber-500/40'
                          } disabled:opacity-60 disabled:cursor-not-allowed`}
                          title="Login directo a Telecable desde el VPS (sin CR)"
                        >
                          📡 Telecable (VPS)
                        </button>
                      </div>
                      <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
                        {tMode === 'telecable'
                          ? 'Login automático a la API de Telecable desde el VPS. URL HLS firmada se refresca proactivamente. No usa túnel CR.'
                          : scrapingHelp}
                      </p>
                      {tMode === 'telecable' && tInfo && (
                        <div className="mt-2 flex items-center gap-2 text-[11px]">
                          <span className="text-muted-foreground">
                            {tInfo.expires_in_s !== null && tInfo.expires_in_s > 0
                              ? `🟢 URL vence en ${Math.floor(tInfo.expires_in_s / 3600)}h ${Math.floor((tInfo.expires_in_s % 3600) / 60)}m`
                              : '⚪ Sin URL cacheada todavía'}
                            {tInfo.last_login_failure_count > 0 && (
                              <span className="ml-2 text-red-400">· ⚠️ {tInfo.last_login_failure_count} fallo(s)</span>
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })()}
                {channelConfig.scrapeFn && !PASTE_URL_PROCESSES.has(processIndex) && !(processIndex === TELETICA_URL_INDEX && teleticaMode === 'official') && !(processIndex === CANAL6_URL_INDEX && canal6Mode === 'official') && !(TELECABLE_PIDS.has(processIndex) && telecableModes[processIndex] === 'telecable') && (
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium border ${
                        (processIndex === 24 || processIndex === 25)
                          ? 'bg-yellow-500/15 border-yellow-500/40 text-yellow-300'
                          : 'bg-blue-500/15 border-blue-500/40 text-blue-300'
                      }`}
                      title="Cuenta TDMax usada para scrapear este canal"
                    >
                      <span className="opacity-70">🔐 Logueado con:</span>
                      <span className="font-mono">
                        {PI_ACCOUNT_PROCESSES.has(processIndex) ? 'info@media.cr' : 'arlopfa@gmail.com'}
                      </span>
                    </span>
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
                            : processIndex === CANAL6_SRT_INDEX
                              ? CANAL6_SRT_OBS_INGEST_URL
                              : processIndex === TELETICA_SRT_INDEX
                                ? TELETICA_SRT_OBS_INGEST_URL
                                : processIndex === FOXMAS_SRT_INDEX
                                  ? FOXMAS_SRT_OBS_INGEST_URL
                                  : processIndex === FOX_SRT_INDEX
                                    ? FOX_SRT_OBS_INGEST_URL
                                    : PASTE_URL_PROCESSES.has(processIndex)
                            ? 'M3U8 extraído (auto-completado)'
                            : 'https://servidor/origen/playlist.m3u8'
                    }
                    value={process.m3u8}
                    onChange={(e) => updateProcess(processIndex, { m3u8: e.target.value })}
                    readOnly={PASTE_URL_PROCESSES.has(processIndex) || (processIndex === TELETICA_URL_INDEX && teleticaMode === 'official')}
                    className={`flex-1 bg-card border-2 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-primary/50 transition-all duration-200 ${
                      processIndex === 5 && process.isEmitiendo && process.sourceUrl && process.m3u8
                        && (process.sourceUrl === process.m3u8 || process.sourceUrl.startsWith(process.m3u8))
                        ? 'border-yellow-400 shadow-[0_0_8px_rgba(250,204,21,0.4)]'
                        : PASTE_URL_PROCESSES.has(processIndex)
                          ? 'border-border bg-muted/40'
                          : 'border-border'
                    }`}
                  />
                  {channelConfig.scrapeFn && !PASTE_URL_PROCESSES.has(processIndex) && !(processIndex === TELETICA_URL_INDEX && teleticaMode === 'official') && !(processIndex === CANAL6_URL_INDEX && canal6Mode === 'official') && (
                    <button
                      onClick={async () => {
                        if (TELECABLE_PIDS.has(processIndex) && telecableModes[processIndex] === 'telecable') {
                          setFetchingChannel(processIndex);
                          try {
                            const r = await fetch(`/api/telecable/${processIndex}/refresh`, { method: 'POST' });
                            const j = await r.json().catch(() => ({}));
                            if (r.ok) {
                              if (j.url) updateProcess(processIndex, { m3u8: j.url });
                              toast.success(`URL Telecable refrescada (vence en ${Math.floor((j.expires_in_s || 0) / 3600)}h)`);
                            } else {
                              toast.error(j.error || 'No se pudo refrescar');
                            }
                          } catch (e: any) {
                            toast.error(e?.message || 'Error de red');
                          } finally {
                            setFetchingChannel(null);
                          }
                          return;
                        }
                        fetchChannelUrl(processIndex);
                      }}
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
                </>
                )}
                {/* Backup URL field removed - Canal 6 now uses single URL */}
              </>
            )}

            <div className="mb-4 p-3 rounded-xl bg-card/50 border border-border">
              <label className="block text-sm mb-2 text-muted-foreground">Formato de salida</label>
              <select
                value={outputProfile}
                onChange={(e) => setOutputProfile(processIndex, e.target.value as OutputProfile)}
                disabled={process.isEmitiendo || process.emitStatus === 'starting'}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {SRT_INGEST_INDEXES.has(processIndex) && (
                  <option value="passthrough">{OUTPUT_PROFILE_LABELS.passthrough}</option>
                )}
                <option value="normal">{OUTPUT_PROFILE_LABELS.normal}</option>
                <option value="balanced">{OUTPUT_PROFILE_LABELS.balanced}</option>
                <option value="optimized">{OUTPUT_PROFILE_LABELS.optimized}</option>
              </select>
              <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
                {outputProfile === 'passthrough'
                  ? 'La señal sale del VPS EXACTAMENTE como la manda OBS (resolución/bitrate/codec). Cero re-encode, cero pérdida de calidad, CPU ~3%. Recomendado para SRT: configurá OBS en 720p · 2000-3000 kbps CBR · H264 main · keyframe 2s · AAC 128k 48 kHz.'
                  : outputProfile === 'optimized'
                  ? 'Máximo ahorro de ancho de banda (480p · 1200k). Ideal para eventos masivos donde el LB suele caer. Calidad buena en celular/tablet.'
                  : outputProfile === 'balanced'
                  ? 'Sweet spot calidad/ancho de banda (540p · 1500k · preset faster). Recomendado para eventos grandes sin sacrificar nitidez visible.'
                  : 'Perfil estándar de producción (720p · 2000k). Mejor calidad, mayor consumo por usuario.'}
              </p>
            </div>

            {HLS_OUTPUT_PROCESSES.has(processIndex) ? (() => {
              const hlsSlugs: Record<number, string> = {
                [0]: 'Disney7',
                [FUTV_URL_INDEX]: 'futv',
                [TIGO_URL_INDEX]: 'Tigo',
                [TELETICA_URL_INDEX]: 'Teletica',
                [TDMAS1_URL_INDEX]: 'Tdmas1',
                [CANAL6_URL_INDEX]: 'Canal6',
                [DISNEY7_URL_INDEX]: 'Disney7',
                [FUTV_ALTERNO_INDEX]: 'futv',
                [FUTV_SRT_INDEX]: 'futv',
                [RANDOM_DISNEY7_INDEX]: 'Disney7',
                [CANAL6_SRT_INDEX]: 'Canal6',
                [TELETICA_SRT_INDEX]: 'Teletica',
                [FOXMAS_SRT_INDEX]: 'foxmas',
                [FOX_SRT_INDEX]: 'fox',
                [FOXMAS_URL_INDEX]: 'foxmas',
                [FOX_URL_INDEX]: 'fox',
                [FOXMAS_ALTERNO_INDEX]: 'foxmas',
                [CANAL8_URL_INDEX]: 'Canal8',
                [CANAL2_URL_INDEX]: 'Canal2',
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
                    : processIndex === CANAL6_SRT_INDEX
                      ? CANAL6_SRT_OBS_INGEST_URL
                      : processIndex === TELETICA_SRT_INDEX
                        ? TELETICA_SRT_OBS_INGEST_URL
                          : processIndex === FOXMAS_SRT_INDEX
                            ? FOXMAS_SRT_OBS_INGEST_URL
                            : processIndex === FOX_SRT_INDEX
                              ? FOX_SRT_OBS_INGEST_URL
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
                      {(() => {
                        const pi5Target: 'teletica' | 'foxmas' | 'fox' | null =
                          processIndex === TELETICA_SRT_INDEX ? 'teletica'
                          : processIndex === FOXMAS_SRT_INDEX ? 'foxmas'
                          : processIndex === FOX_SRT_INDEX ? 'fox'
                          : null;
                        if (!pi5Target) return null;
                        const sendPi5Refresh = async () => {
                          try {
                            const { error } = await supabase
                              .from('pi5_commands')
                              .insert({ target: pi5Target, command: 'refresh' });
                            if (error) throw error;
                            toast.success(`🔄 Refresh enviado al Pi5 (${pi5Target}). Se aplica en ≤15s.`);
                          } catch (e: any) {
                            toast.error(`Error enviando refresh: ${e?.message || e}`);
                          }
                        };
                        return (
                          <div className="flex items-center gap-2 pt-2 border-t border-border/50">
                            <p className="text-xs text-muted-foreground flex-1">
                              Forzar relogin TDMax + nuevo token en el Pi5 (~15s):
                            </p>
                            <button
                              onClick={sendPi5Refresh}
                              className="px-3 py-2 rounded-lg bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-300 text-xs font-semibold transition-all"
                              title="Manda un comando al Raspberry Pi para reciclar ffmpeg y obtener URL fresca de TDMax"
                            >
                              🔄 Refresh Pi5
                            </button>
                          </div>
                        );
                      })()}
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

            {/* Always-On Toggle (excluye solo subida de archivo) */}
            {processIndex !== FILE_UPLOAD_INDEX && (
              <div className="flex items-center gap-3 mt-4 p-3 rounded-xl bg-card/50 border border-primary/30">
                <Switch
                  checked={process.alwaysOn}
                  onCheckedChange={(checked) => void toggleAlwaysOn(processIndex, checked, channelConfig.name)}
                />
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">🔁 Encendido siempre</span>
                  <span className="text-xs text-muted-foreground">
                    {OBS_INGEST_PROCESSES.has(processIndex)
                      ? 'Auto-relanza el listener SRT si cae (sin refresh horario; espera la señal del encoder local)'
                      : 'Auto-relanza tras reinicios y refresca URL a las 12:00 AM y 5:00 AM (hora CR)'}
                  </span>
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

                {/* Snapshots de logs (backups automáticos al terminar el proceso) */}
                <div className="mt-3 pt-3 border-t border-border/50">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      🗂️ Backups de logs:
                    </span>
                    <LogSnapshotsViewer
                      processId={processIndex}
                      refreshKey={process.isEmitiendo ? 0 : process.elapsed}
                    />
                  </div>
                </div>
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
          <div className="mb-6 px-1 overflow-x-auto scrollbar-hide md:overflow-visible">
            <TabsList className="bg-card/60 backdrop-blur-sm p-1.5 rounded-2xl shadow-lg border border-border inline-flex flex-nowrap gap-1 min-w-max md:grid md:[grid-template-columns:repeat(10,minmax(0,1fr))] md:gap-1.5 md:min-w-0 md:w-full md:h-auto">
              {/* Tab UPTIME — vista resumen de señales activas con cronómetro y telemetría */}
              {(() => {
                const activeCount = VISIBLE_PROCESSES.filter(i => processes[i]?.isEmitiendo).length;
                return (
                  <TabsTrigger
                    key="uptime"
                    value="uptime"
                    className={`px-3 py-2 sm:px-4 sm:py-2.5 rounded-xl transition-all duration-200 relative flex-shrink-0 ${
                      activeTab === 'uptime'
                        ? 'bg-primary text-primary-foreground shadow-lg'
                        : 'hover:bg-muted/50'
                    }`}
                  >
                    <span className="relative flex items-center justify-center gap-1 sm:gap-1.5 text-xs sm:text-sm whitespace-nowrap font-semibold">
                      📊 UPTIME
                      {activeCount > 0 && (
                        <span className="ml-1 px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400 text-[10px] font-bold">
                          {activeCount}
                        </span>
                      )}
                    </span>
                  </TabsTrigger>
                );
              })()}
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

          {/* Contenido tab UPTIME — grid responsive de señales activas */}
          <TabsContent key="uptime" value="uptime">
            {(() => {
              const activeIndexes = VISIBLE_PROCESSES.filter(i => processes[i]?.isEmitiendo);
              if (activeIndexes.length === 0) {
                return (
                  <div className="bg-broadcast-panel/60 backdrop-blur-sm rounded-2xl p-12 shadow-lg border border-broadcast-border/50 text-center">
                    <div className="text-5xl mb-3">💤</div>
                    <h2 className="text-xl font-semibold text-muted-foreground mb-1">No hay señales activas</h2>
                    <p className="text-sm text-muted-foreground">Cuando arranques una emisión aparecerá aquí con su cronómetro y telemetría en vivo.</p>
                  </div>
                );
              }
              return (
                <div className="space-y-4">
                  <header className="flex flex-wrap items-center justify-between gap-3 px-1">
                    <div>
                      <h2 className="text-2xl font-bold text-accent flex items-center gap-2">
                        📊 Señales activas
                        <span className="text-xs font-normal px-2 py-1 rounded-md bg-green-500/15 text-green-400 border border-green-500/30">
                          {activeIndexes.length} en vivo
                        </span>
                      </h2>
                      <p className="text-xs text-muted-foreground mt-1">
                        Telemetría refrescada cada 5s · cronómetro cada 1s
                      </p>
                    </div>
                  </header>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {activeIndexes.map((i) => {
                      const p = processes[i];
                      const color = getProcessColor(i);
                      const live = liveStats[i.toString()];
                      const elapsed = p.startTime > 0
                        ? Math.max(0, Math.floor((clockNow - p.startTime) / 1000))
                        : p.elapsed;
                      const isSrt = SRT_INGEST_INDEXES.has(i);
                      const fpsHealthy = live?.fps == null ? true : live.fps >= 25;
                      const speedHealthy = live?.speed == null ? true : live.speed >= 0.95;
                      const dropAlert = (live?.drop ?? 0) > 0;
                      const dupAlert = (live?.dup ?? 0) > 0;
                      const qValue = live?.q;
                      const qHealthy = qValue == null ? true : qValue <= 30;
                      return (
                        <div
                          key={i}
                          className="bg-broadcast-panel/60 backdrop-blur-sm rounded-2xl p-4 shadow-lg border border-broadcast-border/50 hover:border-green-500/40 transition-all duration-200"
                        >
                          <div className="flex items-start justify-between gap-2 mb-3">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="inline-block h-2.5 w-2.5 rounded-full bg-green-400 animate-pulse flex-shrink-0"></span>
                              <h3 className="text-sm font-bold truncate text-green-400" title={color.name}>
                                {color.name}
                              </h3>
                            </div>
                            <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 border border-green-500/30 flex-shrink-0">
                              LIVE
                            </span>
                          </div>

                          <div className="mb-3">
                            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Uptime</div>
                            <div className="font-mono text-2xl font-bold text-primary tabular-nums">
                              {formatSeconds(elapsed)}
                            </div>
                          </div>

                          <div className="grid grid-cols-3 gap-2 text-xs">
                            <div className="bg-background/40 rounded-lg p-2 border border-border/40">
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Bitrate</div>
                              <div className="font-mono font-semibold text-foreground">
                                {live?.bitrateKbps != null ? `${live.bitrateKbps} kbps` : '—'}
                              </div>
                            </div>
                            <div className={`bg-background/40 rounded-lg p-2 border ${fpsHealthy ? 'border-border/40' : 'border-red-500/50'}`}>
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">FPS</div>
                              <div className={`font-mono font-semibold ${fpsHealthy ? 'text-foreground' : 'text-red-400'}`}>
                                {live?.fps != null ? live.fps.toFixed(1) : '—'}
                              </div>
                            </div>
                            <div className={`bg-background/40 rounded-lg p-2 border ${speedHealthy ? 'border-border/40' : 'border-amber-500/50'}`}>
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Speed</div>
                              <div className={`font-mono font-semibold ${speedHealthy ? 'text-foreground' : 'text-amber-400'}`}>
                                {live?.speed != null ? `${live.speed.toFixed(2)}x` : '—'}
                              </div>
                            </div>
                            <div className={`bg-background/40 rounded-lg p-2 border ${dropAlert ? 'border-red-500/50' : 'border-border/40'}`}>
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Drops</div>
                              <div className={`font-mono font-semibold ${dropAlert ? 'text-red-400' : 'text-foreground'}`}>
                                {live?.drop ?? 0}
                              </div>
                            </div>
                            <div className={`bg-background/40 rounded-lg p-2 border ${dupAlert ? 'border-amber-500/50' : 'border-border/40'}`}>
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground" title="Frames duplicados — timing irregular del origen">Dup</div>
                              <div className={`font-mono font-semibold ${dupAlert ? 'text-amber-400' : 'text-foreground'}`}>
                                {live?.dup ?? 0}
                              </div>
                            </div>
                            <div className={`bg-background/40 rounded-lg p-2 border ${qHealthy ? 'border-border/40' : 'border-amber-500/50'}`}>
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground" title="Quantizer — calidad de compresión (≤30 ideal, >30 = bitrate/CPU insuficiente)">Q</div>
                              <div className={`font-mono font-semibold ${qHealthy ? 'text-foreground' : 'text-amber-400'}`}>
                                {qValue != null ? qValue.toFixed(1) : '—'}
                              </div>
                            </div>
                          </div>

                          {isSrt && (live?.srtRttMs != null || live?.srtBwMbps != null || live?.srtPktsLost != null) && (
                            <div className="mt-3 pt-3 border-t border-border/40">
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                                🛰️ Enlace SRT
                              </div>
                              <div className="grid grid-cols-3 gap-1.5 text-[11px]">
                                <div className="bg-background/40 rounded p-1.5 border border-border/40">
                                  <div className="text-[9px] uppercase text-muted-foreground">RTT</div>
                                  <div className="font-mono font-semibold">
                                    {live?.srtRttMs != null ? `${live.srtRttMs.toFixed(0)}ms` : '—'}
                                  </div>
                                </div>
                                <div className="bg-background/40 rounded p-1.5 border border-border/40">
                                  <div className="text-[9px] uppercase text-muted-foreground">BW</div>
                                  <div className="font-mono font-semibold">
                                    {live?.srtBwMbps != null ? `${live.srtBwMbps.toFixed(1)}M` : '—'}
                                  </div>
                                </div>
                                <div className="bg-background/40 rounded p-1.5 border border-border/40">
                                  <div className="text-[9px] uppercase text-muted-foreground">Lost</div>
                                  <div className={`font-mono font-semibold ${(live?.srtPktsLost ?? 0) > 0 ? 'text-red-400' : ''}`}>
                                    {live?.srtPktsLost ?? 0}
                                  </div>
                                </div>
                              </div>
                            </div>
                          )}

                          <button
                            type="button"
                            onClick={() => setActiveTab(i.toString())}
                            className="mt-3 w-full text-[11px] font-medium px-2 py-1.5 rounded-lg bg-muted/40 hover:bg-muted/70 text-muted-foreground hover:text-foreground transition-colors"
                          >
                            Abrir tab →
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </TabsContent>

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
                  <p className={`text-2xl font-bold font-mono ${
                    (latestMetrics?.network.rxPercent || 0) > 80 ? 'text-destructive' :
                    (latestMetrics?.network.rxPercent || 0) > 50 ? 'text-warning' : 'text-primary'
                  }`}>
                    {latestMetrics?.network.rxMbps?.toFixed(1) || '0.0'} <span className="text-sm">Mbps</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {latestMetrics?.network.linkMbps
                      ? `${latestMetrics.network.rxPercent?.toFixed(1) ?? '0.0'}% de ${latestMetrics.network.linkMbps} Mbps`
                      : 'NIC desconocido'}
                  </p>
                </div>
                <div className="bg-card/50 rounded-xl p-4 border border-border">
                  <p className="text-xs text-muted-foreground mb-1">↑ Red (Tx)</p>
                  <p className={`text-2xl font-bold font-mono ${
                    (latestMetrics?.network.txPercent || 0) > 80 ? 'text-destructive' :
                    (latestMetrics?.network.txPercent || 0) > 50 ? 'text-warning' : 'text-primary'
                  }`}>
                    {latestMetrics?.network.txMbps?.toFixed(1) || '0.0'} <span className="text-sm">Mbps</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {latestMetrics?.network.linkMbps
                      ? `${latestMetrics.network.txPercent?.toFixed(1) ?? '0.0'}% de ${latestMetrics.network.linkMbps} Mbps`
                      : 'NIC desconocido'}
                  </p>
                </div>
              </div>

              {/* Indicadores extra: disco, swap, load, ffmpeg */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <div className="bg-card/50 rounded-xl p-4 border border-border">
                  <p className="text-xs text-muted-foreground mb-1">💽 Disco</p>
                  <p className={`text-2xl font-bold font-mono ${
                    (latestMetrics?.disk?.percent || 0) > 85 ? 'text-destructive' :
                    (latestMetrics?.disk?.percent || 0) > 70 ? 'text-warning' : 'text-primary'
                  }`}>
                    {latestMetrics?.disk?.percent?.toFixed(1) ?? '0.0'}%
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {latestMetrics?.disk?.usedGB ?? 0} / {latestMetrics?.disk?.totalGB ?? 0} GB
                  </p>
                </div>
                <div className="bg-card/50 rounded-xl p-4 border border-border">
                  <p className="text-xs text-muted-foreground mb-1" title="Si > 0, la RAM está saturada">🔁 Swap</p>
                  <p className={`text-2xl font-bold font-mono ${
                    (latestMetrics?.swap?.percent || 0) > 10 ? 'text-destructive' :
                    (latestMetrics?.swap?.percent || 0) > 0 ? 'text-warning' : 'text-primary'
                  }`}>
                    {latestMetrics?.swap?.percent?.toFixed(1) ?? '0.0'}%
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {latestMetrics?.swap?.usedMB ?? 0} / {latestMetrics?.swap?.totalMB ?? 0} MB
                  </p>
                </div>
                <div className="bg-card/50 rounded-xl p-4 border border-border">
                  <p className="text-xs text-muted-foreground mb-1" title="loadAvg 1min ÷ cores. >1 = saturado">⚖️ Load ratio</p>
                  <p className={`text-2xl font-bold font-mono ${
                    (latestMetrics?.cpu.loadRatio || 0) > 1 ? 'text-destructive' :
                    (latestMetrics?.cpu.loadRatio || 0) > 0.7 ? 'text-warning' : 'text-primary'
                  }`}>
                    {latestMetrics?.cpu.loadRatio?.toFixed(2) ?? '0.00'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    load {latestMetrics?.loadAvg?.[0]?.toFixed(2) ?? '0.00'} / {latestMetrics?.cpu.cores ?? 0} cores
                  </p>
                </div>
                <div className="bg-card/50 rounded-xl p-4 border border-border">
                  <p className="text-xs text-muted-foreground mb-1">🎬 FFmpeg</p>
                  <p className="text-2xl font-bold font-mono text-primary">
                    {latestMetrics?.ffmpegCount ?? 0}
                  </p>
                  <p className="text-xs text-muted-foreground">procesos activos</p>
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
                  <h3 className="text-sm font-medium text-muted-foreground mb-3">
                    🌐 Red (Mbps){latestMetrics?.network.linkMbps ? ` · NIC ${latestMetrics.network.linkMbps} Mbps` : ''}
                  </h3>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={metricsHistory}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="time" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                      <Tooltip 
                        contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontSize: '12px' }}
                        labelStyle={{ color: 'hsl(var(--foreground))' }}
                      />
                      <Line type="monotone" dataKey="rxMbps" stroke="#22c55e" strokeWidth={2} dot={false} name="↓ Rx Mbps" />
                      <Line type="monotone" dataKey="txMbps" stroke="#f97316" strokeWidth={2} dot={false} name="↑ Tx Mbps" />
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
