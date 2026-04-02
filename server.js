import express from 'express';
import cors from 'cors';
import { spawn, execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import { createClient } from '@supabase/supabase-js';

// Configurar cliente de Supabase (opcional, solo si hay variables de entorno)
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

let supabase = null;

if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('✅ Cliente de Supabase inicializado correctamente.');
} else {
  console.warn('⚠️ Supabase no está configurado (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). Se desactivan logs persistentes en base de datos.');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configurar multer para subida de archivos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 } // 5GB max
});

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3001;

// WebSocket server para logs en tiempo real
const wss = new WebSocketServer({ server, path: '/ws' });
const connectedClients = new Set();

wss.on('connection', (ws) => {
  console.log('🔌 Cliente conectado al sistema de logs');
  connectedClients.add(ws);
  
  // Enviar log de bienvenida
  sendLog('system', 'info', 'Cliente conectado al sistema de logs en tiempo real');
  
  ws.on('close', () => {
    console.log('🔌 Cliente desconectado del sistema de logs');
    connectedClients.delete(ws);
  });
  
  ws.on('error', (error) => {
    console.error('❌ Error en WebSocket:', error);
    connectedClients.delete(ws);
  });
});

// Función para enviar logs a todos los clientes conectados
const sendLog = (processId, level, message, details = null) => {
  const logData = {
    id: Date.now() + Math.random().toString(),
    timestamp: Date.now(),
    processId,
    level,
    message,
    details
  };
  
  const logMessage = JSON.stringify(logData);
  
  connectedClients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      try {
        client.send(logMessage);
      } catch (e) {
        console.error('Error enviando log a cliente:', e);
        connectedClients.delete(client);
      }
    }
  });
};

// Función para enviar notificación de fallo específico
const sendFailureNotification = (processId, failureType, details) => {
  const failureData = {
    type: 'failure',
    processId,
    failureType, // 'source', 'rtmp', 'server'
    timestamp: Date.now(),
    details
  };
  
  const message = JSON.stringify(failureData);
  
  connectedClients.forEach((client) => {
    if (client.readyState === 1) {
      try {
        client.send(message);
      } catch (e) {
        console.error('Error enviando notificación de fallo:', e);
        connectedClients.delete(client);
      }
    }
  });
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

// Variables globales para manejo de múltiples procesos ffmpeg
const ffmpegProcesses = new Map(); // Map<processId, { process, status, startTime, target_rtmp }>
const emissionStatuses = new Map(); // Map<processId, status>
const autoRecoveryInProgress = new Map(); // Map<processId, boolean>
const manualStopProcesses = new Set(); // Procesos detenidos manualmente (no hacer auto-recovery)
const nightRestStoppedProcesses = new Set(); // Procesos apagados por descanso nocturno
const detectedErrors = new Map(); // Map<processId, { type, reason }> — último error detectado por stderr


// FUTV Auto-recovery: obtener nueva URL y reiniciar emisión
const SUPABASE_FUNCTIONS_URL = `https://${(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace('https://', '').replace(/\/$/, '')}/functions/v1`;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';

// Mapa de canales scrapeados (definido una sola vez, usado en recovery y drop-signal)
const CHANNEL_MAP = {
  '1': { channelId: '641cba02e4b068d89b2344e3', channelName: 'FUTV' },
  '3': { channelId: '66608d188f0839b8a740cfe9', channelName: 'TDmas 1' },
  '4': { channelId: '617c2f66e4b045a692106126', channelName: 'Teletica' },
  '6': { channelId: '664e5de58f089fa849a58697', channelName: 'Multimedios' },
};

// Canales con URL directa (sin scraping TDMax) — recovery reutiliza la misma URL guardada en DB
// Canal 6 ahora funciona igual que Disney 7/8: el usuario pega la URL manualmente
const DIRECT_URL_CHANNELS = {
  // '5' ya no tiene URL fija — se trata como Disney (manual)
};

// Procesos manuales (Disney 7, Canal 6, Disney 8): recovery reutiliza la URL guardada en DB
const MANUAL_URL_PROCESSES = new Set(['0', '5', '10']);

// Fallback URLs oficiales por canal (se usan si el scraping falla)
const CHANNEL_FALLBACK_URLS = {
  '6': 'https://mdstrm.com/live-stream-playlist/5a7b1e63a8da282c34d65445.m3u8', // Multimedios oficial
};

// Track de intentos de recovery para saber cuándo usar fallback
const recoveryAttempts = new Map(); // Map<processId, number>

// Cache de resolución por canal para evitar re-sondear en cada recovery
const resolutionCache = new Map(); // Map<process_id, { needsRecode, width, height }>

// Cache de sesión de scraping: guarda cookies + accessToken para pasarlos a FFmpeg
// Esto es CRÍTICO para Tigo cuyo CDN valida cookies/token junto con la IP
const scrapeSessionCache = new Map(); // Map<processId, { cookies, accessToken, timestamp }>

// Control de retry rápido para evitar loops cuando la misma URL vuelve a caer enseguida
const quickRetryState = new Map(); // Map<processId, lastQuickRetryTimestampMs>

// Watchdog: última vez que cada proceso produjo frames (timestamp ms)
const lastFrameTime = new Map(); // Map<processId, timestampMs>
const lastProgressLog = new Map(); // Map<processId, timestampMs> — throttle de logs de progreso
const PROGRESS_LOG_INTERVAL = 5000; // Loguear progreso cada 5 segundos
const WATCHDOG_STALL_TIMEOUT = 30000; // 30 segundos sin frames en running = proceso colgado
const WATCHDOG_START_TIMEOUT = 25000; // 25 segundos en starting sin primer frame = arranque colgado
const WATCHDOG_CHECK_INTERVAL = 10000; // Revisar cada 10 segundos
const HLS_INPUT_RESILIENCE_ARGS = [
  '-rw_timeout', '10000000', // 10 segundos - tope máximo si la conexión se cuelga sin respuesta
  '-reconnect', '1',
  '-reconnect_streamed', '1',
  '-reconnect_at_eof', '1',
  '-reconnect_on_http_error', '5xx',
  '-reconnect_delay_max', '5',
];

// Watchdog interval: detecta procesos FFmpeg colgados, tanto en arranque como en ejecución
setInterval(() => {
  for (const [processId, processData] of ffmpegProcesses.entries()) {
    if (!processData.process || processData.process.killed) continue;
    
    const lastFrame = lastFrameTime.get(processId);
    const status = emissionStatuses.get(processId);
    const runtimeMs = Date.now() - (processData.startTime || Date.now());

    // Caso 1: proceso pegado arrancando y nunca produjo el primer frame
    if (status === 'starting' && !lastFrame && runtimeMs > WATCHDOG_START_TIMEOUT) {
      const stalledSecs = Math.floor(runtimeMs / 1000);
      sendLog(processId, 'error', `🐕 WATCHDOG: Arranque colgado — ${stalledSecs}s sin primer frame. Forzando cierre para recovery...`);

      detectedErrors.set(processId, {
        type: 'source',
        reason: `Arranque colgado: ${stalledSecs}s sin primer frame (fuente/token/handshake bloqueado)`
      });

      if (supabase) {
        supabase
          .from('emission_processes')
          .update({
            failure_reason: 'stall',
            failure_details: `Watchdog de arranque: ${stalledSecs}s sin primer frame`,
            emit_status: 'error',
          })
          .eq('id', parseInt(processId))
          .then(() => {})
          .catch(err => console.error('Watchdog start DB error:', err));
      }

      try {
        processData.process.kill('SIGKILL');
      } catch (e) {
        console.error(`Watchdog start: error matando proceso ${processId}:`, e);
      }

      continue;
    }
    
    // Caso 2: proceso ya estaba corriendo y dejó de producir frames
    if (status !== 'running') continue;
    if (!lastFrame) continue;
    
    const stalledMs = Date.now() - lastFrame;
    if (stalledMs > WATCHDOG_STALL_TIMEOUT) {
      const stalledSecs = Math.floor(stalledMs / 1000);
      sendLog(processId, 'error', `🐕 WATCHDOG: Proceso colgado — ${stalledSecs}s sin producir frames. Forzando cierre para recovery...`);
      
      detectedErrors.set(processId, { 
        type: 'source', 
        reason: `Proceso colgado: ${stalledSecs}s sin frames (CDN/fuente dejó de responder)` 
      });
      
      if (supabase) {
        supabase
          .from('emission_processes')
          .update({
            failure_reason: 'stall',
            failure_details: `Watchdog: ${stalledSecs}s sin frames — CDN/fuente dejó de enviar datos`,
            emit_status: 'error',
          })
          .eq('id', parseInt(processId))
          .then(() => {})
          .catch(err => console.error('Watchdog DB error:', err));
      }
      
      try {
        processData.process.kill('SIGKILL');
      } catch (e) {
        console.error(`Watchdog: error matando proceso ${processId}:`, e);
      }
      
      lastFrameTime.delete(processId);
    }
  }
}, WATCHDOG_CHECK_INTERVAL);


// ==================== SCRAPING ON-DEMAND ====================
// Scraping simple: login → obtener URL → listo. Sin pool ni sesiones persistentes.
// Se usa un deviceId fijo por servidor para no crear sesiones fantasma en TDMax.
const FIXED_DEVICE_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const STREANN_RESELLER_ID = '61316705e4b0295f87dae396';
const STREANN_BASE_URL = 'https://cf.streann.tech';

// Scraping LOCAL (directo desde el VPS) — el token se genera con la IP del VPS
// así el CDN valida correctamente la IP que hace el request de video
const scrapeStreamUrlLocal = async (channelId, channelName) => {
  sendLog('system', 'info', `🔄 Scraping LOCAL ${channelName}: obteniendo URL desde VPS...`);
  
  const email = process.env.TDMAX_EMAIL;
  const password = process.env.TDMAX_PASSWORD;
  
  if (!email || !password) {
    return { url: null, error: 'Credenciales TDMAX no configuradas en el VPS (TDMAX_EMAIL / TDMAX_PASSWORD)' };
  }
  
  try {
    // Paso 1: Login — capturar cookies de la respuesta
    const loginResp = await fetch(`${STREANN_BASE_URL}/web/services/v3/external/login?r=${STREANN_RESELLER_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Origin': 'https://www.tdmax.com',
        'Referer': 'https://www.tdmax.com/',
      },
      body: JSON.stringify({
        username: email.toLowerCase(),
        password: password,
      }),
    });
    
    // Capturar todas las cookies del login
    const loginCookies = loginResp.headers.getSetCookie ? loginResp.headers.getSetCookie() : [];
    const loginCookieStr = loginCookies.map(c => c.split(';')[0]).join('; ');
    
    const loginData = await loginResp.json();
    
    if (loginData.errorMessage) {
      return { url: null, error: `Login error: ${loginData.errorMessage}` };
    }
    
    const accessToken = loginData.accessToken || loginData.access_token;
    if (!accessToken) {
      return { url: null, error: 'No se obtuvo token de acceso' };
    }
    
    sendLog('system', 'info', `✅ Login exitoso para ${channelName}${loginCookies.length > 0 ? ` (${loginCookies.length} cookies capturadas)` : ''}, obteniendo stream URL...`);
    
    // Paso 2: Obtener URL del stream — pasar cookies del login y capturar nuevas
    const lbUrl = `${STREANN_BASE_URL}/loadbalancer/services/v1/channels-secure/${channelId}/playlist.m3u8?r=${STREANN_RESELLER_ID}&deviceId=${FIXED_DEVICE_ID}&accessToken=${encodeURIComponent(accessToken)}&doNotUseRedirect=true&countryCode=CR&deviceType=web&appType=web`;
    
    const lbHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Origin': 'https://www.tdmax.com',
      'Referer': 'https://www.tdmax.com/',
      'Authorization': `Bearer ${accessToken}`,
    };
    // Pasar cookies del login al loadbalancer
    if (loginCookieStr) {
      lbHeaders['Cookie'] = loginCookieStr;
    }
    
    const lbResp = await fetch(lbUrl, { headers: lbHeaders });
    
    if (!lbResp.ok) {
      const errorText = await lbResp.text();
      return { url: null, error: `Error obteniendo stream: ${lbResp.status} - ${errorText.substring(0, 200)}` };
    }
    
    // Capturar cookies del loadbalancer también
    const lbCookies = lbResp.headers.getSetCookie ? lbResp.headers.getSetCookie() : [];
    const allCookieParts = [
      ...loginCookies.map(c => c.split(';')[0]),
      ...lbCookies.map(c => c.split(';')[0]),
    ];
    const allCookieStr = allCookieParts.join('; ');
    
    const lbData = await lbResp.json();
    const streamUrl = lbData.url;
    
    if (!streamUrl) {
      return { url: null, error: 'No se encontró URL de stream en la respuesta' };
    }
    
    const cookieCount = allCookieParts.filter(Boolean).length;
    sendLog('system', 'success', `✅ URL LOCAL obtenida para ${channelName}${cookieCount > 0 ? ` (${cookieCount} cookies para CDN)` : ''}`);
    
    // Retornar URL + accessToken + cookies para que FFmpeg los use
    return { url: streamUrl, accessToken, cookies: allCookieStr || null };
  } catch (err) {
    return { url: null, error: `Error en scraping local: ${err.message}` };
  }
};

// Scraping vía Edge Function (fallback si el local no está disponible)
const scrapeStreamUrlRemote = async (channelId, channelName) => {
  sendLog('system', 'info', `🔄 Scraping REMOTO ${channelName}: obteniendo URL via Edge Function...`);
  
  try {
    const resp = await fetch(`${SUPABASE_FUNCTIONS_URL}/scrape-channel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ mode: 'full', channel_id: channelId }),
    });
    const data = await resp.json();
    
    if (data.success && data.url) {
      sendLog('system', 'success', `✅ URL REMOTA obtenida para ${channelName}`);
      return { url: data.url };
    }
    
    return { url: null, error: data.error || 'No se obtuvo URL' };
  } catch (err) {
    return { url: null, error: err.message };
  }
};

// Obtiene stream URL: primero intenta LOCAL (mismo IP), luego REMOTO (Edge Function)
const scrapeStreamUrl = async (channelId, channelName) => {
  // Intentar primero scraping local (para que el token se genere con la IP del VPS)
  const localResult = await scrapeStreamUrlLocal(channelId, channelName);
  if (localResult.url) {
    return localResult;
  }
  
  sendLog('system', 'warn', `⚠️ Scraping local falló (${localResult.error}), intentando vía Edge Function...`);
  
  // Fallback: Edge Function
  return await scrapeStreamUrlRemote(channelId, channelName);
};
// ==================== FIN SCRAPING ====================

// ==================== TIGO SESSION EXTRACTION ====================
// Nimble Streamer usa `nimblesessionid` para mantener sesiones HLS vivas.
// Al hacer el primer fetch del playlist, los segmentos contienen este session ID.
// Si appendeamos el nimblesessionid a la URL del playlist, Nimble reconoce
// la sesión existente y no requiere un wmsAuthSign válido para reloads.

const extractNimbleSession = async (playlistUrl, headers = {}) => {
  try {
    const resp = await fetch(playlistUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        ...headers,
      },
    });
    if (!resp.ok) return { sessionId: null, error: `HTTP ${resp.status}` };
    
    const body = await resp.text();
    
    // Buscar nimblesessionid en las URLs de segmentos
    const sessionMatch = body.match(/nimblesessionid=(\d+)/);
    if (sessionMatch) {
      return { sessionId: sessionMatch[1], error: null };
    }
    
    // También puede venir como redirect o en headers
    const locationHeader = resp.headers.get('location');
    if (locationHeader) {
      const locMatch = locationHeader.match(/nimblesessionid=(\d+)/);
      if (locMatch) return { sessionId: locMatch[1], error: null };
    }
    
    return { sessionId: null, error: 'No nimblesessionid found in playlist' };
  } catch (err) {
    return { sessionId: null, error: err.message };
  }
};

// Enriquecer una URL con nimblesessionid
const appendNimbleSession = (url, sessionId) => {
  if (!sessionId) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('nimblesessionid', sessionId);
    return parsed.toString();
  } catch (_) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}nimblesessionid=${sessionId}`;
  }
};
// ==================== FIN TIGO SESSION ====================






// Espera a que el proceso FFmpeg esté completamente muerto (con timeout agresivo)
const waitForProcessDeath = (proc, timeoutMs = 1500) => {
  return new Promise((resolve) => {
    if (!proc || proc.killed || proc.exitCode !== null) {
      return resolve();
    }
    let resolved = false;
    // SIGKILL inmediato si no muere en timeoutMs
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { proc.kill('SIGKILL'); } catch (e) {}
        resolve();
      }
    }, timeoutMs);
    proc.on('close', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve();
      }
    });
  });
};

const autoRecoverChannel = async (process_id, channelId, channelName = 'Canal') => {
  if (autoRecoveryInProgress.get(process_id)) {
    sendLog(process_id, 'warn', '⏳ Auto-recovery ya en progreso, ignorando...');
    return;
  }
  
  autoRecoveryInProgress.set(process_id, true);
  const attempts = (recoveryAttempts.get(process_id) || 0) + 1;
  recoveryAttempts.set(process_id, attempts);
  
  let newUrl = null;
  const fallbackUrl = CHANNEL_FALLBACK_URLS[process_id];
  
  // Si es el segundo intento (o más) y hay fallback, usar directamente la URL oficial
  if (attempts >= 2 && fallbackUrl) {
    sendLog(process_id, 'warn', `🔄 AUTO-RECOVERY ${channelName} (intento #${attempts}): Usando URL oficial de respaldo...`);
    newUrl = fallbackUrl;
  } else {
    sendLog(process_id, 'info', `🔄 AUTO-RECOVERY ${channelName} (intento #${attempts}): Obteniendo nueva URL...`);
    
    try {
      const result = await scrapeStreamUrl(channelId, channelName);
      
      if (result.url) {
        newUrl = result.url;
        // Cachear sesión para FFmpeg (cookies + token)
        if (result.cookies || result.accessToken) {
          scrapeSessionCache.set(String(process_id), {
            cookies: result.cookies || null,
            accessToken: result.accessToken || null,
            timestamp: Date.now(),
          });
          sendLog(process_id, 'info', `🔐 Sesión de recovery cacheada (cookies: ${result.cookies ? 'sí' : 'no'})`);
        }
        sendLog(process_id, 'success', `✅ URL obtenida para ${channelName}`);
      } else if (fallbackUrl) {
        sendLog(process_id, 'warn', `⚠️ Scraping falló (${result.error || 'sin URL'}), usando URL oficial de respaldo para ${channelName}`);
        newUrl = fallbackUrl;
      } else {
        sendLog(process_id, 'error', `❌ AUTO-RECOVERY falló: ${result.error || 'No se obtuvo URL'}`);
        autoRecoveryInProgress.set(process_id, false);
        return;
      }
    } catch (scrapeError) {
      if (fallbackUrl) {
        sendLog(process_id, 'warn', `⚠️ Error en scraping (${scrapeError.message}), usando URL oficial de respaldo`);
        newUrl = fallbackUrl;
      } else {
        sendLog(process_id, 'error', `❌ AUTO-RECOVERY error: ${scrapeError.message}`);
        autoRecoveryInProgress.set(process_id, false);
        return;
      }
    }
  }
  
  try {
    const newUrl_display = newUrl === fallbackUrl ? '🏛️ URL OFICIAL' : newUrl.substring(0, 80) + '...';
    sendLog(process_id, 'success', `✅ Nueva URL ${channelName}: ${newUrl_display}`);
    
    // CRÍTICO: Asegurarse de que el proceso anterior esté COMPLETAMENTE muerto antes de reiniciar
    const existingProc = ffmpegProcesses.get(process_id);
    if (existingProc && existingProc.process && !existingProc.process.killed) {
      sendLog(process_id, 'info', '🔪 Terminando proceso anterior antes de reiniciar...');
      existingProc.process.kill('SIGKILL'); // SIGKILL directo para máxima velocidad
      await waitForProcessDeath(existingProc.process, 1500);
      ffmpegProcesses.delete(process_id);
      sendLog(process_id, 'info', '✔ Proceso anterior terminado correctamente');
    }
    
    let targetRtmp = '';
    if (supabase) {
      const { data: row } = await supabase
        .from('emission_processes')
        .select('rtmp')
        .eq('id', parseInt(process_id))
        .single();
      if (row?.rtmp) targetRtmp = row.rtmp;
    }
    
    if (!targetRtmp) {
      sendLog(process_id, 'error', `❌ AUTO-RECOVERY: No se encontró RTMP destino para proceso ${process_id}`);
      autoRecoveryInProgress.set(process_id, false);
      return;
    }
    
    if (supabase) {
      await supabase
        .from('emission_processes')
        .update({ m3u8: newUrl, emit_status: 'starting', is_emitting: true, is_active: true })
        .eq('id', parseInt(process_id));
    }
    
    sendLog(process_id, 'info', '🚀 AUTO-RECOVERY: Reiniciando emisión con nueva URL...');
    
    const emitUrl = `http://localhost:${PORT}/api/emit`;
    const emitResp = await fetch(emitUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_m3u8: newUrl,
        target_rtmp: targetRtmp,
        process_id: process_id,
        is_recovery: true
      })
    });
    
    if (!emitResp.ok) {
      const errText = await emitResp.text().catch(() => '');
      sendLog(process_id, 'error', `❌ AUTO-RECOVERY: El endpoint /api/emit respondió ${emitResp.status}: ${errText.substring(0, 100)}`);
    } else {
      sendLog(process_id, 'success', '✅ AUTO-RECOVERY completado: Emisión reiniciada correctamente');
      // Incrementar contador de recovery en la base de datos
      if (supabase) {
        try {
          const { error: rpcErr } = await supabase.rpc('increment_recovery_count', { process_id: parseInt(process_id) });
          if (rpcErr) {
            // Fallback: leer valor actual y sumar 1 si la función RPC falla
            const { data: currentRow } = await supabase
              .from('emission_processes')
              .select('recovery_count')
              .eq('id', parseInt(process_id))
              .single();
            const currentCount = currentRow?.recovery_count || 0;
            await supabase
              .from('emission_processes')
              .update({ recovery_count: currentCount + 1 })
              .eq('id', parseInt(process_id));
          }
        } catch (fallbackErr) {
          console.error('Error incrementando recovery_count:', fallbackErr.message);
        }
      }
      // Si fue exitoso con URL oficial, resetear intentos
      if (newUrl === fallbackUrl) {
        recoveryAttempts.set(process_id, 0);
      }
    }
  } catch (error) {
    sendLog(process_id, 'error', `❌ AUTO-RECOVERY error: ${error.message}`);
  } finally {
    autoRecoveryInProgress.set(process_id, false);
  }
};

// Función para verificar si un destino RTMP ya está en uso
const checkRTMPConflict = (target_rtmp, current_process_id) => {
  for (const [processId, processData] of ffmpegProcesses.entries()) {
    if (processId !== current_process_id && 
        processData.target_rtmp === target_rtmp && 
        processData.process && 
        !processData.process.killed) {
      return processId;
    }
  }
  return null;
};

// Función mejorada para detectar y categorizar problemas
const detectAndCategorizeError = (output, processId) => {
  const isEOF = output.includes('End of file') || output.includes('error=End of file');
  const isReconnectEOF = isEOF && output.includes('Will reconnect at');
  const proc = ffmpegProcesses.get(processId);
  const elapsed = proc ? (Date.now() - proc.startTime) / 1000 : 999;

  // Mensaje transitorio de FFmpeg durante reconexión automática: no tratar como error.
  if (isReconnectEOF) {
    return true;
  }

  // Detectar errores de fuente M3U8
  // Para procesos manuales (0, 5, 10) con reconnect 4xx habilitado,
  // los 404 transitorios son manejados internamente por FFmpeg — no tratar como fatal
  const isManualProcess = MANUAL_URL_PROCESSES.has(String(processId));
  
  if (output.includes('Invalid data found') || 
      output.includes('Server returned 404') ||
      output.includes('Server returned 403') ||
      output.includes('HTTP error 403') ||
      output.includes('Server returned 5') ||
      output.includes('End of file') ||
      output.includes('error=End of file') ||
      (output.includes('Connection refused') && output.includes('http'))) {
    
    // Filtrar errores de "End of file" durante los primeros 10 segundos (son normales al arrancar HLS multi-variante)
    if (isEOF && elapsed < 10) {
      return true; // Ignorar silenciosamente, no es un error real
    }

    // Para procesos manuales: 404 y EOF transitorios suelen venir del CDN.
    // Los tratamos como advertencia operativa, pero sí dejamos la causa registrada
    // por si FFmpeg termina cerrando el proceso después de agotar sus reintentos internos.
    if (isManualProcess && (output.includes('Server returned 404') || (isEOF && elapsed > 10))) {
      const reason = output.includes('404')
        ? '404 transitorio del CDN (FFmpeg reintentará internamente)'
        : 'EOF transitorio del CDN (FFmpeg reintentará internamente)';
      sendLog(processId, 'warn', `⚠️ CDN: ${reason}`);
      detectedErrors.set(processId, { type: 'source', reason });
      return true; // No marcar como error fatal inmediato
    }

    const reason = output.includes('404') ? 'URL Fuente M3U8 no encontrada (404)' :
                   output.includes('403') ? 'Sesión expirada o token inválido (403 Forbidden)' :
                   output.includes('End of file') ? 'Fuente M3U8 agotada o CDN cortó conexión (EOF)' :
                   output.includes('Invalid data') ? 'URL Fuente M3U8 inválida o corrupta' :
                   output.includes('Connection refused') ? 'CDN rechazó conexión (Connection refused)' :
                   'URL Fuente M3U8 no accesible';
    sendLog(processId, 'error', `ERROR DE FUENTE: ${reason}`);
    sendFailureNotification(processId, 'source', reason);
    // Guardar error detectado para usarlo cuando FFmpeg cierre
    detectedErrors.set(processId, { type: 'source', reason });
    
    // No matamos el proceso aquí para evitar carreras con reinicios nuevos.
    // Dejamos que FFmpeg cierre naturalmente y el handler "close" dispare el recovery.

    return true;
  }
  
  // Detectar errores de destino RTMP (incluyendo Broken pipe)
  if (output.includes('Connection to tcp://') && output.includes('failed') ||
      output.includes('RTMP handshake failed') ||
      output.includes('rtmp://') && output.includes('failed') ||
      output.includes('Server rejected') ||
      output.includes('Connection reset by peer') ||
      output.includes('Broken pipe') ||
      output.includes('Unable to publish')) {
    const reason = output.includes('Broken pipe') ? 'Servidor RTMP cerró la conexión (Broken pipe)' :
                   output.includes('Connection to tcp://') && output.includes('failed') ? 'Destino RTMP no responde o URL incorrecta' :
                   output.includes('RTMP handshake failed') ? 'Fallo en handshake RTMP (verificar URL)' :
                   output.includes('Server rejected') ? 'Servidor RTMP rechazó la conexión' :
                   output.includes('Connection reset') ? 'Conexión RTMP resetteada por el servidor' :
                   'No se pudo publicar al destino RTMP';
    sendLog(processId, 'error', `ERROR DE RTMP: ${reason}`);
    sendFailureNotification(processId, 'rtmp', reason);
    detectedErrors.set(processId, { type: 'rtmp', reason });
    return true;
  }
  
  // Detectar errores del servidor/FFmpeg
  if (output.includes('Cannot allocate memory') ||
      output.includes('Killed') ||
      output.includes('Segmentation fault') ||
      output.includes('out of memory')) {
    const reason = output.includes('memory') ? 'Servidor sin memoria suficiente' :
                   output.includes('Killed') ? 'Proceso FFmpeg terminado por el sistema' :
                   'Fallo crítico del servidor';
    sendLog(processId, 'error', `ERROR DEL SERVIDOR: ${reason}`);
    sendFailureNotification(processId, 'server', reason);
    detectedErrors.set(processId, { type: 'server', reason });
    return true;
  }
  
  return false;
};

// Función para resolver variante de un master HLS playlist
// targetBandwidth: si se pasa (en bps), selecciona la variante más cercana sin exceder ese target.
//                  Si no se pasa o es 0, selecciona la de mayor BANDWIDTH.
const resolveBestHLSVariant = async (masterUrl, targetBandwidth = 0) => {
  try {
    const resp = await fetch(masterUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });
    const body = await resp.text();
    
    // Si no es un master playlist (no tiene #EXT-X-STREAM-INF), devolver la URL original
    if (!body.includes('#EXT-X-STREAM-INF')) {
      return { resolvedUrl: masterUrl, bandwidth: 0, resolution: 'direct' };
    }
    
    // Parsear todas las variantes
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    const variants = [];
    
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
        const bandwidth = bwMatch ? parseInt(bwMatch[1]) : 0;
        const resMatch = lines[i].match(/RESOLUTION=([\dx]+)/);
        const resolution = resMatch ? resMatch[1] : null;
        const variantUrl = lines[i + 1];
        
        if (variantUrl && !variantUrl.startsWith('#')) {
          variants.push({ bandwidth, resolution, url: variantUrl });
        }
      }
    }
    
    if (variants.length === 0) {
      return { resolvedUrl: masterUrl, bandwidth: 0, resolution: 'unknown' };
    }

    // Ordenar por bandwidth ascendente
    variants.sort((a, b) => a.bandwidth - b.bandwidth);
    
    let selected;
    if (targetBandwidth > 0) {
      // Seleccionar la variante más alta que no exceda el target
      // Si ninguna cabe, tomar la más baja disponible
      const fitting = variants.filter(v => v.bandwidth <= targetBandwidth);
      selected = fitting.length > 0 ? fitting[fitting.length - 1] : variants[0];
    } else {
      // Sin target: tomar la más alta
      selected = variants[variants.length - 1];
    }
    
    let bestUrl = selected.url;
    
    // Resolver URL relativa
    if (!bestUrl.startsWith('http')) {
      const base = new URL(masterUrl);
      bestUrl = new URL(bestUrl, base).toString();
    }
    
    const resolution = selected.resolution || `${Math.round(selected.bandwidth / 1000)}kbps`;
    
    // Log de todas las variantes disponibles para diagnóstico
    const variantList = variants.map(v => `${v.resolution || '?'} @ ${Math.round(v.bandwidth / 1000)}kbps`).join(' | ');
    console.log(`HLS variants: [${variantList}] → Selected: ${resolution} @ ${Math.round(selected.bandwidth / 1000)}kbps (target: ${targetBandwidth > 0 ? Math.round(targetBandwidth / 1000) + 'kbps' : 'MAX'})`);
    
    return { resolvedUrl: bestUrl, bandwidth: selected.bandwidth, resolution, allVariants: variants };
  } catch (err) {
    console.error('Error parsing HLS master playlist:', err.message);
    return { resolvedUrl: masterUrl, bandwidth: 0, resolution: 'fallback', allVariants: [] };
  }
};

// Función auxiliar para detectar resolución y bitrate de cualquier fuente (M3U8 o archivo)
const detectSourceInfo = async (source) => {
  return new Promise((resolve) => {
    const probe = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,bit_rate',
      '-show_entries', 'format=bit_rate',
      '-of', 'json',
      source
    ]);
    
    let output = '';
    probe.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    probe.on('close', () => {
      try {
        const data = JSON.parse(output);
        const width = data.streams?.[0]?.width || 0;
        const height = data.streams?.[0]?.height || 0;
        // Bitrate: intentar stream, luego format (en bps, convertir a kbps)
        const streamBitrate = parseInt(data.streams?.[0]?.bit_rate || '0');
        const formatBitrate = parseInt(data.format?.bit_rate || '0');
        const bitrateKbps = Math.round((streamBitrate || formatBitrate) / 1000);
        resolve({ width, height, bitrateKbps });
      } catch (e) {
        resolve({ width: 0, height: 0, bitrateKbps: 0 });
      }
    });
    
    probe.on('error', () => {
      resolve({ width: 0, height: 0, bitrateKbps: 0 });
    });
  });
};

// Endpoint para scraping LOCAL desde el VPS (para que el token se genere con la IP del VPS)
// Esto es CRÍTICO para canales como Tigo cuyo CDN valida IP del token vs IP del consumidor
app.post('/api/local-scrape', async (req, res) => {
  try {
    const { channel_id, process_id } = req.body;
    
    if (!channel_id) {
      return res.status(400).json({ success: false, error: 'Falta channel_id' });
    }
    
    const channelName = CHANNEL_MAP[process_id]?.channelName || `Canal ${channel_id.substring(0, 8)}`;
    const result = await scrapeStreamUrlLocal(channel_id, channelName);
    
    if (!result.url) {
      return res.json({ success: false, error: result.error || 'No se obtuvo URL' });
    }
    
    // Guardar sesión en cache para que /api/emit la use con FFmpeg
    if (process_id !== undefined) {
      scrapeSessionCache.set(String(process_id), {
        cookies: result.cookies || null,
        accessToken: result.accessToken || null,
        timestamp: Date.now(),
      });
      sendLog(String(process_id), 'info', `🔐 Sesión de scraping guardada en cache (cookies: ${result.cookies ? 'sí' : 'no'}, token: ${result.accessToken ? 'sí' : 'no'})`);
    }
    
    return res.json({ success: true, url: result.url, channel: channelName });
  } catch (error) {
    console.error('Error en /api/local-scrape:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint para iniciar emisión
app.post('/api/emit', async (req, res) => {
  try {
    const { source_m3u8, target_rtmp, process_id: rawProcessId = '0', is_recovery = false } = req.body;
    const process_id = String(rawProcessId);
    const numericId = parseInt(process_id, 10);
    let effectiveSourceM3u8 = source_m3u8;

    // Validación de ID: debe ser un número entre 0 y 10
    if (isNaN(numericId) || numericId < 0 || numericId > 10) {
      sendLog(process_id, 'error', `❌ ID de proceso inválido: "${rawProcessId}" (debe ser 0-10)`);
      return res.status(400).json({ error: `ID de proceso inválido: debe ser un número entre 0 y 10` });
    }

    // Resetear contador y limpiar flags de parada manual SOLO cuando es inicio manual
    if (!is_recovery) {
      recoveryAttempts.set(process_id, 0);
      manualStopProcesses.delete(process_id);
      manualStopProcesses.delete(numericId);
      nightRestStoppedProcesses.delete(process_id);
    }
    
    sendLog(process_id, 'info', `Nueva solicitud de emisión recibida`, { source_m3u8, target_rtmp });

    // Validaciones
    if (!effectiveSourceM3u8 || !target_rtmp) {
      sendLog(process_id, 'error', 'Faltan parámetros requeridos: source_m3u8 y target_rtmp');
      return res.status(400).json({ 
        error: 'Faltan parámetros requeridos: source_m3u8 y target_rtmp' 
      });
    }

    // (Tigo processes removed — dead code cleaned up)

    // VALIDACIÓN CRÍTICA: Verificar conflicto de destino RTMP
    const conflictingProcessId = checkRTMPConflict(target_rtmp, process_id);
    if (conflictingProcessId) {
      const conflictingProcess = ffmpegProcesses.get(conflictingProcessId);
      sendLog(process_id, 'error', `⚠️ CONFLICTO: El destino RTMP ya está en uso por Proceso ${conflictingProcessId}`);
      sendLog(conflictingProcessId, 'warn', `⚠️ Otro proceso (${process_id}) intenta usar el mismo destino RTMP - deteniendo este proceso`);
      
      // Detener el proceso conflictivo
      if (conflictingProcess && conflictingProcess.process && !conflictingProcess.process.killed) {
        manualStopProcesses.add(String(conflictingProcessId));
        manualStopProcesses.add(Number(conflictingProcessId));
        conflictingProcess.process.kill('SIGTERM');
        ffmpegProcesses.delete(conflictingProcessId);
        emissionStatuses.set(conflictingProcessId, 'idle');
      }
    }

    // Si ya hay un proceso corriendo para este ID, detenerlo primero
    const existingProcess = ffmpegProcesses.get(process_id);
    manualStopProcesses.delete(process_id); // Limpiar flag de parada manual al iniciar nueva emisión
    if (existingProcess && existingProcess.process && !existingProcess.process.killed) {
      sendLog(process_id, 'warn', `Deteniendo proceso ffmpeg existente para reinicio`);
      manualStopProcesses.add(String(process_id));
      manualStopProcesses.add(Number(process_id));
      existingProcess.process.kill('SIGTERM');
      ffmpegProcesses.delete(process_id);
      
      // Actualizar el registro anterior como finalizado (solo si Supabase está disponible)
      if (supabase) {
        await supabase
          .from('emission_processes')
          .update({ 
            is_active: false, 
            is_emitting: false, 
            ended_at: new Date().toISOString(),
            emit_status: 'stopped',
            start_time: 0,
            elapsed: 0
          })
          .eq('id', parseInt(process_id))
          .eq('is_emitting', true);
      }
    }

    emissionStatuses.set(process_id, 'starting');
    
    // Crear o actualizar registro en base de datos (solo si Supabase está disponible)
    let dbRecord = null;
    if (supabase) {
      // Resetear recovery_count y failure state en inicio manual
      const upsertData = {
          id: parseInt(process_id),
          m3u8: effectiveSourceM3u8,
          rtmp: target_rtmp,
          is_active: true,
          is_emitting: true,
          emit_status: 'starting',
          start_time: Math.floor(Date.now() / 1000),
          process_logs: `[${new Date().toISOString()}] Iniciando emisión desde M3U8\n`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          failure_reason: null,
          failure_details: null,
      };
      // Solo resetear contadores en inicio manual (no en recovery)
      if (!is_recovery) {
        upsertData.recovery_count = 0;
        upsertData.last_signal_duration = 0;
      }
      const { data, error: dbError } = await supabase
        .from('emission_processes')
        .upsert(upsertData, { onConflict: 'id' })
        .select()
        .single();

      dbRecord = data || null;

      if (dbError) {
        sendLog(process_id, 'warn', `Error guardando en DB: ${dbError.message}`);
      } else {
        sendLog(process_id, 'info', `✅ Proceso guardado en base de datos (ID: ${process_id})`);
      }
    } else {
      sendLog(process_id, 'warn', 'Supabase no configurado: no se guardará el proceso en base de datos.');
    }
    
    let ffmpegArgs;
    
    // Si es recovery, damos un poco menos de análisis para reenganchar rápido,
    // pero suficiente para evitar fallos por parámetros incompletos de streams HLS.
    const isRecovery = Boolean(is_recovery);
    const analyzeDuration = isRecovery ? '1500000' : '3000000';  // 1.5s / 3s
    const probeSize      = isRecovery ? '500000'  : '1500000';   // 500KB / 1.5MB

    // Detectar cabeceras HTTP según dominio fuente y canal para mayor compatibilidad
    const isManualProcess = MANUAL_URL_PROCESSES.has(String(process_id));
    let refererDomain = 'https://www.tdmax.com/';
    let originDomain = 'https://www.tdmax.com';
    let isUnivisionLikeSource = false;
    try {
      const sourceUrl = new URL(effectiveSourceM3u8);
      const hostname = sourceUrl.hostname.toLowerCase();

      if (hostname.includes('teletica.com')) {
        refererDomain = 'https://www.teletica.com/';
        originDomain = 'https://www.teletica.com';
      } else if (hostname.includes('cloudfront.net') || hostname.includes('repretel.com')) {
        refererDomain = 'https://www.repretel.com/';
        originDomain = 'https://www.repretel.com';
      } else if (
        hostname.includes('univisionnow.com') ||
        hostname.includes('univision.com') ||
        hostname.includes('tudn.com') ||
        hostname.includes('vix.com')
      ) {
        isUnivisionLikeSource = true;
        refererDomain = 'https://www.tudn.com/';
        originDomain = 'https://www.tudn.com';
      }
    } catch (_) {
      // Mantener fallback TDMax si la URL llega incompleta o malformada
    }

    // Tigo (procesos 2, 8, 9): su CDN Streann valida headers más estrictos
    const isTigo = ['2', '8', '9'].includes(String(process_id));
    if (isTigo) {
      refererDomain = 'https://www.tdmax.com/';
      originDomain = 'https://www.tdmax.com';
    }

    const hardenedLiveInputArgs = [];
    if (isManualProcess || isUnivisionLikeSource) {
      hardenedLiveInputArgs.push(
        '-http_seekable', '0',
        '-max_reload', '1000',
        '-m3u8_hold_counters', '1000'
      );
      // Para fuentes tipo TUDN/Univision: throttlear lectura a velocidad real (1x)
      // para no descargar segmentos más rápido que un navegador y evitar detección de bot
      if (isUnivisionLikeSource) {
        hardenedLiveInputArgs.push('-re');
      }
    }

    // Recuperar sesión de scraping cacheada (cookies + accessToken) para inyectar a FFmpeg
    // Para Tigo (proceso 2), el proxy maneja la auth y los segmentos tienen sus propios tokens
    const cachedSession = scrapeSessionCache.get(process_id);
    let extraFfmpegInputArgs = [];
    let authorizationHeader = null;
    if (cachedSession && !isTigo) {
      const sessionAge = Date.now() - cachedSession.timestamp;
      if (sessionAge < 600000) { // 10 minutos de TTL para cubrir recoveries lentos
        if (cachedSession.cookies) {
          extraFfmpegInputArgs.push('-cookies', cachedSession.cookies + '\n');
          sendLog(process_id, 'info', `🍪 Inyectando cookies de sesión a FFmpeg`);
        }
        if (cachedSession.accessToken) {
          authorizationHeader = `Authorization: Bearer ${cachedSession.accessToken}`;
          sendLog(process_id, 'info', `🔑 Inyectando accessToken a FFmpeg`);
        }
      } else {
        sendLog(process_id, 'warn', `⚠️ Sesión cacheada expirada (${Math.round(sessionAge/1000)}s), no se inyectan cookies`);
        scrapeSessionCache.delete(process_id);
      }
    }

    const combinedHeaders = [
      authorizationHeader,
      `Referer: ${refererDomain}`,
      `Origin: ${originDomain}`,
    ].filter(Boolean).join('\r\n') + '\r\n';

    const inputArgs = [
      ...HLS_INPUT_RESILIENCE_ARGS,
      ...extraFfmpegInputArgs,
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      '-headers', combinedHeaders,
    ];

    // Para Tigo, FFmpeg ya apunta al proxy local, no necesita resolución de variante
    let inputSourceUrl = effectiveSourceM3u8;

    // Proceso 0 (Disney 7), 5 (Canal 6) y 10 (Disney 8): Tomar MEJOR variante + HD @ 2800kbps
    const isHDProcess = String(process_id) === '0' || String(process_id) === '5' || String(process_id) === '10';
    
    if (isHDProcess) {
      const preferredBandwidth = isUnivisionLikeSource ? 5000000 : 0;
      const { resolvedUrl, bandwidth, resolution, allVariants } = await resolveBestHLSVariant(effectiveSourceM3u8, preferredBandwidth);
      const actualSource = resolvedUrl;
      const bwKbps = Math.round(bandwidth / 1000);
      
      if (allVariants && allVariants.length > 0) {
        const varList = allVariants.map(v => `${v.resolution || '?'} @ ${Math.round(v.bandwidth / 1000)}kbps`).join(' | ');
        sendLog(process_id, 'info', `📋 Variantes disponibles: ${varList}`);
      }
      const hdLabels = { '0': 'Disney 7', '5': 'Canal 6', '10': 'Disney 8' };
      const procLabel = hdLabels[String(process_id)] || 'HD';
      const sourceSelectionLabel = preferredBandwidth > 0 ? 'mejor calidad estable' : 'mejor calidad';
      sendLog(process_id, 'success', `📺 ${procLabel}: Fuente seleccionada → ${resolution} @ ${bwKbps}kbps (${sourceSelectionLabel})`);
      sendLog(process_id, 'info', `🎬 ${procLabel}: CBR 2500k + VBV 720p HD (preset medium)${isRecovery ? ' [recovery]' : ''}`);
      
      ffmpegArgs = [
        ...inputArgs,
        ...hardenedLiveInputArgs,
        '-fflags', '+genpts',
        '-analyzeduration', analyzeDuration,
        '-probesize', probeSize,
        '-i', actualSource,
        '-map', '0:v:0?', '-map', '0:a:0?',
         '-c:v', 'libx264',
         '-preset', 'veryfast',
         '-profile:v', 'main',
         '-threads', '4',
         '-b:v', '2000k',
         '-maxrate', '2000k',
         '-bufsize', '4000k',
        '-g', '60',
        '-keyint_min', '60',
        '-sc_threshold', '0',
        '-r', '30',
        '-vf', 'scale=-2:720',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-max_muxing_queue_size', '1024',
        '-reset_timestamps', '1',
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize',
        '-rtmp_live', 'live',
        target_rtmp,
      ];
    } else {
      // Demás procesos: 720p @ 2500kbps
      const channelLabels = { '1': 'FUTV', '3': 'TDmas 1', '4': 'Teletica', '6': 'Multimedios', '7': 'Subida' };
      const procName = channelLabels[String(process_id)] || `Proceso ${process_id}`;
      sendLog(process_id, 'info', `🎬 ${procName}: CBR 2500k + VBV 720p (preset medium)${isRecovery ? ' [recovery]' : ''}...`);
      
      ffmpegArgs = [
        ...inputArgs,
        '-fflags', '+genpts',
        '-analyzeduration', analyzeDuration,
        '-probesize', probeSize,
        '-i', inputSourceUrl,
        '-map', '0:v:0?', '-map', '0:a:0?',
         '-c:v', 'libx264',
         '-preset', 'veryfast',
         '-profile:v', 'main',
         '-threads', '4',
         '-b:v', '2000k',
         '-maxrate', '2000k',
         '-bufsize', '4000k',
        '-vf', 'scale=-2:720',
        '-r', '30',
        '-g', '60',
        '-keyint_min', '60',
        '-sc_threshold', '0',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-max_muxing_queue_size', '1024',
        '-reset_timestamps', '1',
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize',
        '-rtmp_live', 'live',
        target_rtmp,
      ];
    }

    const commandStr = 'ffmpeg ' + ffmpegArgs.join(' ');
    sendLog(process_id, 'info', `Comando ejecutado: ${commandStr.substring(0, 100)}...`);

    // Ejecutar ffmpeg
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    const processInfo = { 
      process: ffmpegProcess, 
      status: 'starting',
      startTime: Date.now(),
      target_rtmp: target_rtmp,
       source_m3u8: effectiveSourceM3u8
    };
    ffmpegProcesses.set(process_id, processInfo);

    // Manejar salida estándar
    ffmpegProcess.stdout.on('data', (data) => {
      const output = data.toString();
      sendLog(process_id, 'info', `FFmpeg stdout: ${output.trim()}`);
    });

    // Buffer para capturar las últimas líneas de stderr (diagnóstico de crashes)
    const stderrBuffer = [];
    const MAX_STDERR_LINES = 15;
    
    // Manejar errores con análisis mejorado
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      // Guardar en buffer circular para diagnóstico
      const lines = output.split('\n').filter(l => l.trim());
      for (const line of lines) {
        stderrBuffer.push(line.trim());
        if (stderrBuffer.length > MAX_STDERR_LINES) stderrBuffer.shift();
      }

      // 1) Clasificar primero causas reales (aunque no contengan "error/failed")
      const wasCategorized = detectAndCategorizeError(output, process_id);
      if (wasCategorized) return;
      
      // Detectar diferentes tipos de mensajes
      if (output.includes('frame=') || output.includes('fps=')) {
        // Progreso normal — actualizar watchdog
        lastFrameTime.set(process_id, Date.now());
        const currentStatus = emissionStatuses.get(process_id);
        if (currentStatus === 'starting') {
          emissionStatuses.set(process_id, 'running');
          sendLog(process_id, 'success', `Emisión iniciada exitosamente`);
          
          // Actualizar base de datos a estado 'running'
          if (supabase) {
            supabase
              .from('emission_processes')
              .update({
                emit_status: 'running',
                is_active: true,
                is_emitting: true,
                updated_at: new Date().toISOString()
              })
              .eq('id', parseInt(process_id))
              .then(() => {})
              .catch(err => console.error('Error actualizando estado a running:', err));
          }
        }
        
        // Extraer estadísticas básicas del progreso (throttled a cada 10s)
        const frameMatch = output.match(/frame=\s*(\d+)/);
        const fpsMatch = output.match(/fps=\s*([\d.]+)/);
        const bitrateMatch = output.match(/bitrate=\s*([\d.]+)kbits\/s/);
        
        if (frameMatch && fpsMatch) {
          const now = Date.now();
          const lastLog = lastProgressLog.get(process_id) || 0;
          if (now - lastLog >= PROGRESS_LOG_INTERVAL) {
            lastProgressLog.set(process_id, now);
            sendLog(process_id, 'info', `Progreso: frame=${frameMatch[1]}, fps=${fpsMatch[1]}, bitrate=${bitrateMatch ? bitrateMatch[1] + 'kbps' : 'N/A'}`);
          }
        }
      } else if (
        output.includes('not enough frames to estimate rate') ||
        output.includes('Could not find codec parameters') ||
        output.includes('consider increasing the value for the')
      ) {
        sendLog(process_id, 'warn', `FFmpeg warning: ${output.trim()}`);
      } else if (
        output.includes('error') || output.includes('Error') ||
        output.includes('failed') || output.includes('Failed') ||
        output.includes('Connection reset by peer') ||
        output.includes('Broken pipe')
      ) {
        const isStoppingNow =
          emissionStatuses.get(process_id) === 'stopping' ||
          manualStopProcesses.has(process_id) ||
          manualStopProcesses.has(String(process_id)) ||
          manualStopProcesses.has(Number(process_id));

        // Filtrar ruido de FFmpeg que NO son errores reales:
        // - cierre manual (SIGTERM) mientras FFmpeg todavía parsea HLS
        // - estadísticas finales del encoder
        const isNoise =
          /\[libx264 @/.test(output) ||
          /\[aac @/.test(output) ||
          /\[h264 @/.test(output) ||
          output.includes("Skip ('#EXT-X-") ||
          output.includes('keepalive request failed') ||
          output.includes('Error in the pull function') ||
          output.includes('retrying with new connection') ||
          (isStoppingNow && output.includes('Error when loading first segment')) ||
          (isStoppingNow && output.includes('Immediate exit requested')) ||
          (isStoppingNow && output.includes('Output file #0 does not contain any stream')) ||
          (isStoppingNow && output.includes('received signal 15'));
        if (isNoise) {
          return;
        }

        sendLog(process_id, 'error', `FFmpeg error: ${output.trim()}`);
      } else if (output.includes('warning') || output.includes('Warning')) {
        // Advertencia
        sendLog(process_id, 'warn', `FFmpeg warning: ${output.trim()}`);
      } else {
        // Información general (solo las líneas importantes)
        if (output.includes('Stream #') || output.includes('Input #') || output.includes('Output #')) {
          sendLog(process_id, 'info', `FFmpeg: ${output.trim()}`);
        }
      }
    });

    // Manejar cierre del proceso
    ffmpegProcess.on('close', async (code, signal) => {
      const processInfo = ffmpegProcesses.get(process_id);
      const runtime = processInfo ? Date.now() - processInfo.startTime : 0;
      const statusAtClose = emissionStatuses.get(process_id);
      const isManualStop =
        statusAtClose === 'stopping' ||
        manualStopProcesses.has(process_id) ||
        manualStopProcesses.has(String(process_id)) ||
        manualStopProcesses.has(Number(process_id));

      const rawDiagnosticLines = stderrBuffer
        .filter(l => !l.includes('frame=') && !l.includes('fps='))
        .slice(-8);

      const diagnosticLines = rawDiagnosticLines
        .filter(l =>
          !/\[libx264 @/.test(l) &&
          !/\[aac @/.test(l) &&
          !/\[h264 @/.test(l) &&
          !l.includes('Conversion failed') &&
          !l.includes('Immediate exit requested') &&
          !l.includes('Output file #0 does not contain any stream') &&
          !l.includes('Exiting normally, received signal 15')
        )
        .slice(-8);

      const finalStatus = isManualStop ? 'stopped' : (code === 0 ? 'stopped' : 'error');
      const signalInfo = signal ? `, signal: ${signal}` : '';
      const logMessage = isManualStop
        ? `FFmpeg detenido manualmente (runtime: ${Math.floor(runtime / 1000)}s${signalInfo})`
        : code === 0
          ? `FFmpeg terminó exitosamente (código: ${code}, runtime: ${Math.floor(runtime / 1000)}s${signalInfo})`
          : `FFmpeg terminó con error (código: ${code}, runtime: ${Math.floor(runtime / 1000)}s${signalInfo})`;

      if (isManualStop || code === 0) {
        sendLog(process_id, 'success', logMessage);
      } else if (diagnosticLines.length > 0) {
        sendLog(process_id, 'error', logMessage);
        sendLog(process_id, 'error', `📋 Últimas líneas de FFmpeg:\n${diagnosticLines.join('\n')}`);
        sendFailureNotification(process_id, 'server', `Proceso terminado con código de error ${code}`);
      } else if (rawDiagnosticLines.length > 0) {
        // Si no hay diagnóstico "limpio", mostrar crudo para no ocultar la causa real
        sendLog(process_id, 'error', logMessage);
        sendLog(process_id, 'error', `📋 Diagnóstico crudo FFmpeg:\n${rawDiagnosticLines.join('\n')}`);
        sendFailureNotification(process_id, 'server', `Proceso terminado con código de error ${code}`);
      } else {
        sendLog(process_id, 'error', `${logMessage} (sin salida de diagnóstico)`);
      }
      
      // Actualizar base de datos (solo si Supabase está disponible)
      const runtimeSeconds = Math.floor(runtime / 1000);
      if (supabase) {
        const diagSource = diagnosticLines.length > 0 ? diagnosticLines : rawDiagnosticLines;
        const diagInfo = !isManualStop && code !== 0 && diagSource.length > 0
          ? `\n[DIAGNÓSTICO] ${diagSource.slice(-5).join(' | ')}`
          : '';
        
        // Recuperar el error detectado durante stderr parsing
        const detectedError = detectedErrors.get(process_id);
        detectedErrors.delete(process_id);
        
        // Log de la URL que estaba en uso al momento de la caída
        const procAtClose = processInfo || {};
        const urlAtFailure = procAtClose.source_m3u8 || source_m3u8 || 'desconocida';
        if (!isManualStop && code !== 0) {
          sendLog(process_id, 'warn', `📎 URL al momento de caída: ${urlAtFailure.substring(0, 120)}`);
        }

        const updateData = {
          is_active: false,
          is_emitting: false,
          emit_status: finalStatus,
          ended_at: new Date().toISOString(),
          process_logs: `[${new Date().toISOString()}] ${logMessage}${diagInfo}\n`,
          elapsed: runtimeSeconds,
          start_time: 0
        };
        
        // Guardar failure_reason y failure_details si hubo error (no manual)
        if (!isManualStop) {
          if (detectedError) {
            updateData.failure_reason = detectedError.type;
            updateData.failure_details = detectedError.reason;
          } else if (code !== 0 && code !== null) {
            updateData.failure_reason = 'unknown';
            updateData.failure_details = diagSource.length > 0 
              ? `Exit code ${code}: ${diagSource.slice(-3).join(' | ')}` 
              : `Exit code ${code} sin diagnóstico (posible crash silencioso o kill del sistema)`;
          } else if (code === 0) {
            updateData.failure_reason = 'eof';
            updateData.failure_details = 'FFmpeg salió con código 0 (fuente expirada, EOF, o CDN cortó)';
          }
        }
        
        // Guardar duración de la última señal antes de reiniciar (solo si no es parada manual)
        if (!isManualStop && runtimeSeconds > 0) {
          updateData.last_signal_duration = runtimeSeconds;
          sendLog(process_id, 'info', `⏱️ Última señal duró: ${Math.floor(runtimeSeconds / 3600)}h ${Math.floor((runtimeSeconds % 3600) / 60)}m ${runtimeSeconds % 60}s`);
        }
        
        await supabase
          .from('emission_processes')
          .update(updateData)
          .eq('id', parseInt(process_id));
      }
      
      emissionStatuses.set(process_id, 'idle');
      ffmpegProcesses.delete(process_id);
      resolutionCache.delete(process_id); // Limpiar caché de resolución
      lastFrameTime.delete(process_id); // Limpiar watchdog
      
      // AUTO-RECOVERY: Para canales con scraping (usa CHANNEL_MAP global)

      if (isManualStop) {
        sendLog(process_id, 'info', '🛑 Parada manual detectada - Auto-recovery desactivado');
        manualStopProcesses.delete(process_id);
        manualStopProcesses.delete(String(process_id));
        manualStopProcesses.delete(Number(process_id));
        quickRetryState.delete(process_id);
      } else if (code !== null || signal) {
        // Auto-recovery para CUALQUIER cierre no manual (código de salida o señal como SIGKILL del watchdog)
        const isCleanExit = code === 0;
        if (isCleanExit) {
          sendLog(process_id, 'warn', `⚠️ FFmpeg salió con código 0 (fuente expirada o EOF) - Intentando auto-recovery...`);
        }
        
        // MEJORA #2: Retry con misma URL antes de recovery completo
        // Para canales scrapeados (1-6, 8, 9), intentar primero con la misma URL
        // ya que muchas caídas son micro-cortes del CDN donde la URL sigue válida
        const shouldRetryFirst = !!CHANNEL_MAP[process_id];
        const lastQuickRetryAt = quickRetryState.get(process_id) || 0;
        const quickRetryRecentlyFailed = lastQuickRetryAt > 0 && (Date.now() - lastQuickRetryAt) < 30000;

        // Si duró estable suficiente tiempo, permitimos nuevamente retry rápido en futuras caídas.
        if (runtime > 30000 && lastQuickRetryAt > 0) {
          quickRetryState.delete(process_id);
        }

        if (shouldRetryFirst && runtime > 10000 && quickRetryRecentlyFailed) {
          sendLog(process_id, 'warn', '⚠️ RETRY RÁPIDO omitido: caída repetida tras retry reciente, iniciando recovery completo...');
        }
        
        if (shouldRetryFirst && runtime > 10000 && !quickRetryRecentlyFailed) {
          // Solo retry si el proceso corrió más de 10s (evitar loops en URLs inválidas)
          sendLog(process_id, 'info', `🔁 RETRY RÁPIDO: Intentando reiniciar con misma URL antes de recovery completo...`);
          
          setTimeout(async () => {
            try {
              if (!supabase) {
                sendLog(process_id, 'error', '❌ RETRY: Base de datos no disponible, saltando a recovery completo');
                // Ir directo a recovery completo
                if (CHANNEL_MAP[process_id]) {
                  const { channelId, channelName } = CHANNEL_MAP[process_id];
                  autoRecoverChannel(process_id, channelId, channelName);
                }
                return;
              }
              
              const { data: procData } = await supabase
                .from('emission_processes')
                .select('m3u8, rtmp')
                .eq('id', parseInt(process_id))
                .single();
              
              if (procData && procData.m3u8 && procData.rtmp) {
                // Reiniciar con misma URL
                const emitUrl = `http://localhost:${PORT}/api/emit`;
                const emitResp = await fetch(emitUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    source_m3u8: procData.m3u8,
                    target_rtmp: procData.rtmp,
                    process_id: process_id,
                    is_recovery: true
                  })
                });
                
                if (emitResp.ok) {
                  quickRetryState.set(process_id, Date.now());
                  sendLog(process_id, 'success', `✅ RETRY RÁPIDO: Reiniciado con misma URL exitosamente`);
                  // Incrementar recovery_count en DB para contabilizar este retry
                  if (supabase) {
                    const { error: rpcErr } = await supabase.rpc('increment_recovery_count', { process_id: parseInt(process_id) });
                    if (rpcErr) {
                      console.error('Error incrementando recovery_count en retry rápido:', rpcErr.message);
                      // Fallback directo
                      const { data: row } = await supabase.from('emission_processes').select('recovery_count').eq('id', parseInt(process_id)).single();
                      await supabase.from('emission_processes').update({ recovery_count: (row?.recovery_count || 0) + 1 }).eq('id', parseInt(process_id));
                    }
                  }
                  // Monitorear: si cae de nuevo rápido (<15s), la próxima vez va directo a recovery
                } else {
                  sendLog(process_id, 'warn', `⚠️ RETRY RÁPIDO falló, iniciando recovery completo...`);
                  if (CHANNEL_MAP[process_id]) {
                    const { channelId, channelName } = CHANNEL_MAP[process_id];
                    await autoRecoverChannel(process_id, channelId, channelName);
                  }
                }
              } else {
                sendLog(process_id, 'warn', `⚠️ RETRY: No hay URL guardada, saltando a recovery completo`);
                if (CHANNEL_MAP[process_id]) {
                  const { channelId, channelName } = CHANNEL_MAP[process_id];
                  await autoRecoverChannel(process_id, channelId, channelName);
                }
              }
            } catch (retryErr) {
              sendLog(process_id, 'error', `❌ RETRY error: ${retryErr.message}, iniciando recovery completo...`);
              if (CHANNEL_MAP[process_id]) {
                const { channelId, channelName } = CHANNEL_MAP[process_id];
                await autoRecoverChannel(process_id, channelId, channelName);
              }
            }
          }, 500);
        } else if (CHANNEL_MAP[process_id]) {
          // Recovery completo directo (proceso corrió <10s = URL probablemente inválida)
          const { channelId, channelName } = CHANNEL_MAP[process_id];
          if (runtime <= 10000) {
            sendLog(process_id, 'warn', `🔄 ${channelName} caído rápido (${Math.floor(runtime/1000)}s) - URL inválida, recovery completo directo...`);
          } else {
            sendLog(process_id, 'warn', `🔄 ${channelName} caído (código ${code}) - Iniciando recovery completo...`);
          }
          setTimeout(() => {
            autoRecoverChannel(process_id, channelId, channelName);
          }, 500);
        } else if (MANUAL_URL_PROCESSES.has(String(process_id))) {
          // Procesos manuales (Disney 7, Canal 6, Disney 8): reutilizar la misma URL M3U8 guardada en DB
          const procId = parseInt(String(process_id), 10);
          const manualLabels = { '0': 'Disney 7', '5': 'Canal 6', '10': 'Disney 8' };
          const procLabel = manualLabels[String(process_id)] || 'Manual';
          
          // Determinar causa del fallo para log más informativo
          const failureType = detectedErrors.get(process_id);
          const failureInfo = failureType ? ` (${failureType.reason || failureType.type})` : '';
          sendLog(process_id, 'warn', `🔄 ${procLabel} caído (código ${code})${failureInfo} - Reiniciando con misma URL en 500ms...`);
          
          setTimeout(async () => {
            try {
              if (!supabase) {
                sendLog(procId, 'error', `❌ AUTO-RECOVERY ${procLabel}: Base de datos no disponible`);
                return;
              }
              const { data: procData } = await supabase
                .from('emission_processes')
                .select('m3u8, rtmp')
                .eq('id', procId)
                .single();
              
              const sourceUrl = procData?.m3u8;
              const targetRtmp = procData?.rtmp;
              
              if (sourceUrl && targetRtmp) {
                sendLog(procId, 'info', `🔄 AUTO-RECOVERY ${procLabel}: Reiniciando con URL existente...`);
                autoRecoveryInProgress.set(String(process_id), true);
                
                await supabase
                  .from('emission_processes')
                  .update({ emit_status: 'starting', is_emitting: true, is_active: true })
                  .eq('id', procId);
                
                const emitResp = await fetch(`http://localhost:${PORT}/api/emit`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    source_m3u8: sourceUrl,
                    target_rtmp: targetRtmp,
                    process_id: String(process_id),
                    is_recovery: true
                  })
                });
                
                if (emitResp.ok) {
                  sendLog(procId, 'success', `✅ AUTO-RECOVERY ${procLabel} completado: Emisión reiniciada`);
                  if (supabase) {
                    const { error: rpcErr } = await supabase.rpc('increment_recovery_count', { process_id: procId });
                    if (rpcErr) {
                      const { data: row } = await supabase.from('emission_processes').select('recovery_count').eq('id', procId).single();
                      await supabase.from('emission_processes').update({ recovery_count: (row?.recovery_count || 0) + 1 }).eq('id', procId);
                    }
                  }
                } else {
                  sendLog(procId, 'error', `❌ AUTO-RECOVERY ${procLabel} falló: ${emitResp.status}`);
                }
                autoRecoveryInProgress.set(String(process_id), false);
              } else {
                sendLog(procId, 'error', `❌ AUTO-RECOVERY ${procLabel}: No hay M3U8 o RTMP guardados`);
              }
            } catch (err) {
              sendLog(procId, 'error', `❌ AUTO-RECOVERY ${procLabel} error: ${err.message}`);
              autoRecoveryInProgress.set(String(process_id), false);
            }
          }, 500); // 500ms - recovery ultra-rápido para no perder el slot RTMP
        }
      }
    });

    // Manejar error del proceso
    ffmpegProcess.on('error', async (error) => {
      sendLog(process_id, 'error', `Error crítico de FFmpeg: ${error.message}`, { error: error.toString() });
      sendFailureNotification(process_id, 'server', `Error crítico del servidor: ${error.message}`);
      
      // Actualizar base de datos (solo si Supabase está disponible)
      if (supabase) {
        await supabase
          .from('emission_processes')
          .update({
            is_active: false,
            is_emitting: false,
            emit_status: 'error',
            ended_at: new Date().toISOString(),
            failure_reason: 'server',
            failure_details: error.message,
            process_logs: `[${new Date().toISOString()}] Error crítico: ${error.message}\n`,
            start_time: 0,
            elapsed: 0
          })
          .eq('id', parseInt(process_id));
      }
      
      emissionStatuses.set(process_id, 'error');
      ffmpegProcesses.delete(process_id);
      resolutionCache.delete(process_id);
      lastFrameTime.delete(process_id);
    });

    // Timeout de inicio simple
    setTimeout(() => {
      const currentStatus = emissionStatuses.get(process_id);
      const processData = ffmpegProcesses.get(process_id);
      if (currentStatus === 'starting' && processData && processData.process && !processData.process.killed) {
        emissionStatuses.set(process_id, 'running');
      }
    }, 2000);

    res.json({ 
      success: true, 
      message: 'Emisión iniciada correctamente',
      status: 'starting',
      start_time: dbRecord?.start_time || Math.floor(Date.now() / 1000)
    });

  } catch (error) {
    console.error(`❌ Error en /api/emit [${req.body.process_id || '0'}]:`, error);
    emissionStatuses.set(req.body.process_id || '0', 'error');
    res.status(500).json({ 
      error: 'Error interno del servidor', 
      details: error.message 
    });
  }
});

// Endpoint para emitir archivos locales
app.post('/api/emit/files', upload.array('files', 10), async (req, res) => {
  try {
    const { target_rtmp, process_id = '3' } = req.body;
    const files = req.files;

    sendLog(process_id, 'info', `Nueva solicitud de emisión con archivos`, { 
      fileCount: files?.length || 0, 
      target_rtmp 
    });

    // Validaciones
    if (!files || files.length === 0) {
      sendLog(process_id, 'error', 'No se recibieron archivos');
      return res.status(400).json({ 
        error: 'No se recibieron archivos' 
      });
    }

    if (!target_rtmp) {
      sendLog(process_id, 'error', 'Falta parámetro target_rtmp');
      return res.status(400).json({ 
        error: 'Falta parámetro target_rtmp' 
      });
    }

    // VALIDACIÓN CRÍTICA: Verificar conflicto de destino RTMP
    const conflictingProcessId = checkRTMPConflict(target_rtmp, process_id);
    if (conflictingProcessId) {
      const conflictingProcess = ffmpegProcesses.get(conflictingProcessId);
      sendLog(process_id, 'error', `⚠️ CONFLICTO: El destino RTMP ya está en uso por Proceso ${conflictingProcessId}`);
      sendLog(conflictingProcessId, 'warn', `⚠️ Otro proceso (${process_id}) intenta usar el mismo destino RTMP - deteniendo este proceso`);
      
      // Detener el proceso conflictivo
      if (conflictingProcess && conflictingProcess.process && !conflictingProcess.process.killed) {
        manualStopProcesses.add(String(conflictingProcessId));
        manualStopProcesses.add(Number(conflictingProcessId));
        conflictingProcess.process.kill('SIGTERM');
        ffmpegProcesses.delete(conflictingProcessId);
        emissionStatuses.set(conflictingProcessId, 'idle');
      }
    }

    // Si ya hay un proceso corriendo para este ID, detenerlo primero
    const existingProcess = ffmpegProcesses.get(process_id);
    if (existingProcess && existingProcess.process && !existingProcess.process.killed) {
      sendLog(process_id, 'warn', `Deteniendo proceso ffmpeg existente para reinicio`);
      manualStopProcesses.add(String(process_id));
      manualStopProcesses.add(Number(process_id));
      existingProcess.process.kill('SIGTERM');
      ffmpegProcesses.delete(process_id);
      
      // Actualizar el registro anterior como finalizado (solo si Supabase está disponible)
      if (supabase) {
        await supabase
          .from('emission_processes')
          .update({ 
            is_active: false, 
            is_emitting: false, 
            ended_at: new Date().toISOString(),
            emit_status: 'stopped',
            start_time: 0,
            elapsed: 0
          })
          .eq('id', parseInt(process_id))
          .eq('is_emitting', true);
      }
    }

    emissionStatuses.set(process_id, 'starting');
    
    // Crear o actualizar registro en base de datos
    const fileNames = files.map(f => f.originalname).join(', ');
    
    if (!supabase) {
      sendLog(process_id, 'warn', 'Supabase no configurado: no se guardará el proceso en base de datos.');
    }
    
    const dbRecord = supabase ? (await supabase
      .from('emission_processes')
      .upsert({
        id: parseInt(process_id),
        m3u8: `Archivos: ${fileNames}`,
        rtmp: target_rtmp,
        is_active: true,
        is_emitting: true,
        emit_status: 'starting',
        start_time: Math.floor(Date.now() / 1000), // Guardar en segundos
        process_logs: `[${new Date().toISOString()}] Iniciando emisión desde archivos locales: ${fileNames}\n`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' })
      .select()
      .single()).data : null;
    
    if (supabase && dbRecord) {
      sendLog(process_id, 'info', `✅ Proceso guardado en base de datos (ID: ${process_id})`);
    }
    
    // Si hay múltiples archivos, crear un archivo concat
    let inputSource;
    let cleanupFiles = [];
    
    if (files.length === 1) {
      inputSource = files[0].path;
      sendLog(process_id, 'info', `Emitiendo archivo único: ${files[0].originalname}`);
    } else {
      // Crear archivo concat para múltiples videos usando rutas relativas
      const concatFilePath = path.join(__dirname, 'uploads', `concat-${process_id}-${Date.now()}.txt`);
      const concatContent = files.map(f => `file '${path.basename(f.path)}'`).join('\n');
      fs.writeFileSync(concatFilePath, concatContent);
      inputSource = path.basename(concatFilePath);
      cleanupFiles.push(concatFilePath);
      sendLog(process_id, 'info', `Creada playlist con ${files.length} archivos`);
    }

    // Subida: detectar bitrate — copy si ≤5000kbps, re-encode 720p si >5000kbps
    const firstFile = files[0].path;
    sendLog(process_id, 'info', '🔍 Subida: Detectando resolución y bitrate del archivo...');
    const { width: srcW, height: srcH, bitrateKbps: srcBitrate } = await detectSourceInfo(firstFile);
    sendLog(process_id, 'info', `📐 Fuente: ${srcW}x${srcH} @ ${srcBitrate}kbps`);
    
    let videoParams, audioParams;
    
    if (srcBitrate > 0 && srcBitrate <= 5000) {
      // ≤5000kbps: stream copy
      sendLog(process_id, 'info', `✅ Subida: ${srcBitrate}kbps ≤ 5000 → COPY (sin re-encodear)`);
      videoParams = ['-c:v', 'copy'];
      audioParams = ['-c:a', 'copy'];
    } else {
      // >5000kbps o no detectado: re-encodear a 720p @ 2500kbps
      sendLog(process_id, 'info', `📺 Subida: ${srcBitrate || '?'}kbps > 5000 → Re-encode 720p @ 2500kbps (2000-3000k)`);
      videoParams = [
        '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high',
        '-threads', '4', '-crf', '18',
        '-maxrate', '2500k', '-bufsize', '7500k',
        '-vf', 'scale=-2:720',
        '-r', '30', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0'
      ];
      audioParams = ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100'];
    }
    
    let ffmpegArgs;
    
    if (files.length === 1) {
      ffmpegArgs = [
        '-re', '-stream_loop', '-1',
        '-i', path.basename(inputSource),
        ...videoParams,
        ...audioParams,
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize',
        '-rtmp_live', 'live',
        target_rtmp
      ];
    } else {
      ffmpegArgs = [
        '-re', '-f', 'concat', '-safe', '0', '-stream_loop', '-1',
        '-i', inputSource,
        ...videoParams,
        ...audioParams,
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize',
        '-rtmp_live', 'live',
        target_rtmp
      ];
    }

    const commandStr = 'ffmpeg ' + ffmpegArgs.join(' ');
    sendLog(process_id, 'info', `Comando ejecutado: ${commandStr.substring(0, 150)}...`);

    // Ejecutar ffmpeg
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      cwd: path.join(__dirname, 'uploads')
    });
    
    const processInfo = { 
      process: ffmpegProcess, 
      status: 'starting',
      startTime: Date.now(),
      target_rtmp: target_rtmp,
      cleanupFiles: cleanupFiles.concat(files.map(f => f.path))
    };
    ffmpegProcesses.set(process_id, processInfo);

    // Manejar salida (reutilizar lógica existente)
    ffmpegProcess.stdout.on('data', (data) => {
      const output = data.toString();
      sendLog(process_id, 'info', `FFmpeg stdout: ${output.trim()}`);
    });

    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      if (output.includes('frame=') || output.includes('fps=')) {
        const currentStatus = emissionStatuses.get(process_id);
        if (currentStatus === 'starting') {
          emissionStatuses.set(process_id, 'running');
          sendLog(process_id, 'success', `Emisión de archivos iniciada exitosamente`);
        }
        
        const frameMatch = output.match(/frame=\s*(\d+)/);
        const fpsMatch = output.match(/fps=\s*([\d.]+)/);
        if (frameMatch && fpsMatch) {
          const now = Date.now();
          const lastLog = lastProgressLog.get(process_id) || 0;
          if (now - lastLog >= PROGRESS_LOG_INTERVAL) {
            lastProgressLog.set(process_id, now);
            sendLog(process_id, 'info', `Progreso: frame=${frameMatch[1]}, fps=${fpsMatch[1]}`);
          }
        }
      } else if (output.includes('error') || output.includes('Error') || output.includes('failed') || output.includes('Failed')) {
        const isNoise =
          output.includes('Conversion failed') ||
          /\[libx264 @/.test(output) ||
          /\[aac @/.test(output) ||
          /\[h264 @/.test(output) ||
          output.includes('keepalive request failed') ||
          output.includes('Error in the pull function') ||
          output.includes('retrying with new connection');
        if (isNoise) return;
        const wasHandled = detectAndCategorizeError(output, process_id);
        if (!wasHandled) {
          sendLog(process_id, 'error', `FFmpeg error: ${output.trim()}`);
        }
      }
    });

    ffmpegProcess.on('close', async (code) => {
      const processInfo = ffmpegProcesses.get(process_id);
      const runtime = processInfo ? Date.now() - processInfo.startTime : 0;
      
      // Limpiar archivos siempre
      if (processInfo && processInfo.cleanupFiles) {
        processInfo.cleanupFiles.forEach(file => {
          try {
            if (fs.existsSync(file)) {
              fs.unlinkSync(file);
              sendLog(process_id, 'info', `Archivo limpiado: ${path.basename(file)}`);
            }
          } catch (e) {
            console.error(`Error limpiando archivo ${file}:`, e);
          }
        });
      }
      
      const finalStatus = code === 0 ? 'stopped' : 'error';
      const logMessage = code === 0
        ? `FFmpeg terminó exitosamente (runtime: ${Math.floor(runtime/1000)}s)`
        : `FFmpeg terminó con error (código: ${code}, runtime: ${Math.floor(runtime/1000)}s)`;
      
      if (code === 0) {
        sendLog(process_id, 'success', logMessage);
      } else {
        sendLog(process_id, 'error', logMessage);
        sendFailureNotification(process_id, 'server', `Proceso de archivos terminado con código de error ${code}`);
      }
      
      // Actualizar base de datos (solo si Supabase está disponible)
      if (supabase) {
        await supabase
          .from('emission_processes')
          .update({
            is_active: false,
            is_emitting: false,
            emit_status: finalStatus,
            ended_at: new Date().toISOString(),
            process_logs: `[${new Date().toISOString()}] ${logMessage}\n`,
            elapsed: Math.floor(runtime / 1000),
            start_time: 0
          })
          .eq('id', parseInt(process_id));
      }
      
      emissionStatuses.set(process_id, 'idle');
      ffmpegProcesses.delete(process_id);
    });

    ffmpegProcess.on('error', async (error) => {
      sendLog(process_id, 'error', `Error crítico de FFmpeg: ${error.message}`);
      sendFailureNotification(process_id, 'server', `Error crítico del servidor: ${error.message}`);
      
      // Actualizar base de datos (solo si Supabase está disponible)
      if (supabase) {
        await supabase
          .from('emission_processes')
          .update({
            is_active: false,
            is_emitting: false,
            emit_status: 'error',
            ended_at: new Date().toISOString(),
            failure_reason: 'server',
            failure_details: error.message,
            process_logs: `[${new Date().toISOString()}] Error crítico: ${error.message}\n`,
            start_time: 0,
            elapsed: 0
          })
          .eq('id', parseInt(process_id));
      }
      
      emissionStatuses.set(process_id, 'error');
      ffmpegProcesses.delete(process_id);
    });

    setTimeout(() => {
      const currentStatus = emissionStatuses.get(process_id);
      const processData = ffmpegProcesses.get(process_id);
      if (currentStatus === 'starting' && processData && processData.process && !processData.process.killed) {
        emissionStatuses.set(process_id, 'running');
      }
    }, 2000);

    res.json({ 
      success: true, 
      message: `Emisión iniciada con ${files.length} archivo(s)`,
      status: 'starting',
      start_time: dbRecord?.start_time || Math.floor(Date.now() / 1000),
      files: files.map(f => ({ name: f.originalname, size: f.size }))
    });

  } catch (error) {
    const process_id = req.body.process_id || '3';
    console.error(`❌ Error en /api/emit/files [${process_id}]:`, error);
    emissionStatuses.set(process_id, 'error');
    res.status(500).json({ 
      error: 'Error interno del servidor', 
      details: error.message 
    });
  }
});

// Endpoint para detener emisión
app.post('/api/emit/stop', async (req, res) => {
  try {
    const { process_id: rawProcessId = '0' } = req.body;
    const process_id = String(rawProcessId);
    sendLog(process_id, 'info', `Solicitada detención de emisión`);
    
    const processData = ffmpegProcesses.get(process_id) ?? ffmpegProcesses.get(Number(process_id));
    if (processData && processData.process && !processData.process.killed) {
      emissionStatuses.set(process_id, 'stopping');
      manualStopProcesses.add(process_id); // Marcar como parada manual para evitar auto-recovery
      manualStopProcesses.add(Number(process_id));
      
      // Actualizar base de datos antes de detener (solo si Supabase está disponible)
      if (supabase) {
        await supabase
          .from('emission_processes')
          .update({
            is_active: false,
            is_emitting: false,
            emit_status: 'stopped',
            ended_at: new Date().toISOString(),
            start_time: 0,
            elapsed: 0,
            recovery_count: 0,
            last_signal_duration: 0,
            failure_reason: null,
            failure_details: null,
            process_logs: `[${new Date().toISOString()}] Emisión detenida manualmente\n`
          })
          .eq('id', parseInt(process_id));
      }
      
      // Guardar referencia antes de borrar del mapa
      const procRef = processData.process;
      
      // Intentar terminar graciosamente
      procRef.kill('SIGTERM');
      
      // Si no termina en 3 segundos, forzar terminación con SIGKILL
      setTimeout(() => {
        if (procRef && !procRef.killed) {
          sendLog(process_id, 'warn', `Forzando terminación de ffmpeg con SIGKILL`);
          procRef.kill('SIGKILL');
        }
      }, 3000);
      
      // Además, matar por PID directamente como último recurso
      if (procRef.pid) {
        setTimeout(() => {
          try {
            process.kill(procRef.pid, 0); // Verificar si sigue vivo
            sendLog(process_id, 'warn', `⚠️ Proceso PID ${procRef.pid} sigue vivo, matando con kill -9`);
            execSync(`kill -9 ${procRef.pid}`, { timeout: 2000 });
          } catch (e) {
            // El proceso ya murió, ok
          }
        }, 5000);
      }
      
      ffmpegProcesses.delete(process_id);
      resolutionCache.delete(process_id);
      detectedErrors.delete(process_id);
      quickRetryState.delete(process_id);
      lastFrameTime.delete(process_id);
      lastProgressLog.delete(process_id);
      
      emissionStatuses.set(process_id, 'idle');
      sendLog(process_id, 'success', `Emisión detenida correctamente`);
      
      res.json({ 
        success: true, 
        message: `Emisión ${process_id} detenida correctamente` 
      });
    } else {
      emissionStatuses.set(process_id, 'idle');
      sendLog(process_id, 'info', `No hay emisión activa`);
      res.json({ 
        success: true, 
        message: `No hay emisión activa para proceso ${process_id}` 
      });
    }
    
  } catch (error) {
    const pid = req.body?.process_id || '0';
    sendLog(pid, 'error', `Error deteniendo emisión: ${error.message}`);
    res.status(500).json({ 
      error: 'Error interno del servidor', 
      details: error.message 
    });
  }
});


// Endpoint para "Botar Señal": fuerza un cambio de señal en caliente
// Mata FFmpeg, espera que muera, y dispara auto-recovery como si fuera una caída
app.post('/api/emit/drop-signal', async (req, res) => {
  try {
    const { process_id: rawProcessId } = req.body;
    const process_id = String(rawProcessId ?? '');
    
    if (!process_id) {
      return res.status(400).json({ success: false, error: 'Falta process_id' });
    }
    
    const channelInfo = CHANNEL_MAP[process_id];
    const directInfo = DIRECT_URL_CHANNELS[process_id];
    
    // Para procesos sin scraping (Libre=0, Subida=7, etc.), solo matamos FFmpeg
    // y dejamos que la auto-recuperación lo levante con la misma URL
    const processName = channelInfo ? channelInfo.channelName : (directInfo ? directInfo.channelName : `Proceso ${process_id}`);
    
    sendLog(process_id, 'warn', `📡 BOTAR SEÑAL: Forzando caída de ${processName}...`);
    
    // Matar proceso existente y esperar que muera completamente
    const processData = ffmpegProcesses.get(process_id) ?? ffmpegProcesses.get(Number(process_id));
    if (processData && processData.process && !processData.process.killed) {
      sendLog(process_id, 'info', '🔪 Terminando proceso FFmpeg actual...');
      processData.process.kill('SIGTERM');
      await waitForProcessDeath(processData.process, 4000);
      ffmpegProcesses.delete(process_id);
      emissionStatuses.set(process_id, 'idle');
      sendLog(process_id, 'info', '✔ Proceso anterior terminado - la auto-recuperación debería activarse...');
    } else {
      return res.json({ success: false, error: 'No hay proceso FFmpeg activo para matar' });
    }
    
    // Resetear intentos de recuperación
    recoveryAttempts.set(process_id, 0);
    
    if (channelInfo) {
      // Procesos con scraping: disparar auto-recovery con scraping
      res.json({ success: true, message: `Botando señal de ${channelInfo.channelName}...` });
      setTimeout(() => {
        autoRecoverChannel(process_id, channelInfo.channelId, channelInfo.channelName);
      }, 500);
    } else {
      // Procesos sin scraping (Libre, Subida): solo respondemos OK
      // La auto-recuperación del handler 'close' de FFmpeg se encargará
      res.json({ success: true, message: `Señal botada para ${processName}, esperando auto-recuperación...` });
    }
    
  } catch (error) {
    sendLog(req.body?.process_id || '?', 'error', `Error en drop-signal: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Nuevo endpoint para eliminar completamente un proceso específico de la base de datos
app.delete('/api/emit/:process_id', async (req, res) => {
  try {
    const { process_id } = req.params;
    sendLog(process_id, 'info', `Solicitada eliminación del proceso ${process_id}`);
    
    // Primero detener el proceso si está corriendo
    const processData = ffmpegProcesses.get(process_id) ?? ffmpegProcesses.get(Number(process_id));
    if (processData && processData.process && !processData.process.killed) {
      manualStopProcesses.add(process_id); // Marcar como manual para evitar auto-recovery
      manualStopProcesses.add(Number(process_id));
      const procRef = processData.process;
      procRef.kill('SIGKILL');
      ffmpegProcesses.delete(process_id);
      emissionStatuses.set(process_id, 'idle');
      
      // Matar por PID como respaldo
      if (procRef.pid) {
        setTimeout(() => {
          try {
            process.kill(procRef.pid, 0);
            execSync(`kill -9 ${procRef.pid}`, { timeout: 2000 });
          } catch (e) { /* ya murió */ }
        }, 2000);
      }
    }
    
    // Eliminar de la base de datos solo este proceso específico (solo si Supabase está disponible)
    if (supabase) {
      const { error } = await supabase
        .from('emission_processes')
        .delete()
        .eq('id', parseInt(process_id));
      
      if (error) {
        sendLog(process_id, 'error', `Error eliminando de DB: ${error.message}`);
        return res.status(500).json({ 
          error: 'Error eliminando proceso', 
          details: error.message 
        });
      }
      
      sendLog(process_id, 'success', `✅ Proceso ${process_id} eliminado completamente de la base de datos`);
    } else {
      sendLog(process_id, 'warn', 'Supabase no configurado: solo se detuvo el proceso en memoria, no se eliminó de la base de datos.');
    }
    
    res.json({ 
      success: true, 
      message: `Proceso ${process_id} eliminado correctamente` 
    });
  } catch (error) {
    console.error('❌ Error eliminando proceso:', error);
    res.status(500).json({ 
      error: 'Error eliminando proceso', 
      details: error.message 
    });
  }
});

// Endpoint para borrar archivos subidos
app.delete('/api/emit/files', (req, res) => {
  try {
    const { process_id = '3' } = req.body;
    sendLog(process_id, 'info', `Solicitada eliminación de archivos`);
    
    // Detener proceso si está activo
    const processData = ffmpegProcesses.get(process_id);
    if (processData && processData.process && !processData.process.killed) {
      processData.process.kill('SIGTERM');
      ffmpegProcesses.delete(process_id);
    }
    
    // Eliminar archivos del directorio uploads para este proceso
    const uploadsDir = path.join(__dirname, 'uploads');
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      let deletedCount = 0;
      
      files.forEach(file => {
        const filePath = path.join(uploadsDir, file);
        try {
          fs.unlinkSync(filePath);
          deletedCount++;
          sendLog(process_id, 'info', `Archivo eliminado: ${file}`);
        } catch (e) {
          console.error(`Error eliminando archivo ${file}:`, e);
        }
      });
      
      sendLog(process_id, 'success', `${deletedCount} archivos eliminados`);
      res.json({ 
        success: true, 
        message: `${deletedCount} archivos eliminados`,
        deletedCount 
      });
    } else {
      res.json({ 
        success: true, 
        message: 'No hay archivos para eliminar',
        deletedCount: 0 
      });
    }
    
  } catch (error) {
    const process_id = req.body.process_id || '3';
    console.error(`❌ Error eliminando archivos [${process_id}]:`, error);
    res.status(500).json({ 
      error: 'Error interno del servidor', 
      details: error.message 
    });
  }
});



app.get('/api/status', (req, res) => {
  const { process_id } = req.query;
  
  if (process_id) {
    // Estado de un proceso específico
    const processData = ffmpegProcesses.get(process_id);
    const status = emissionStatuses.get(process_id) || 'idle';
    res.json({
      process_id,
      status,
      process_running: processData && processData.process && !processData.process.killed,
      timestamp: new Date().toISOString()
    });
  } else {
    // Estado de todos los procesos
    const allStatuses = {};
    for (let i = 0; i <= 10; i++) {
      const id = i.toString();
      const processData = ffmpegProcesses.get(id);
      allStatuses[id] = {
        status: emissionStatuses.get(id) || 'idle',
        process_running: processData && processData.process && !processData.process.killed
      };
    }
    res.json({
      processes: allStatuses,
      timestamp: new Date().toISOString()
    });
  }
});

// Endpoint de health check
app.get('/api/health', (req, res) => {
  res.json({
    healthy: true,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});



// ===== MÉTRICAS DEL SERVIDOR =====
let prevCpuTimes = null;
let prevNetStats = null;

const getCpuUsage = () => {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  cpus.forEach(cpu => {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });
  
  const currentTimes = { idle: totalIdle, total: totalTick };
  
  if (prevCpuTimes) {
    const idleDiff = currentTimes.idle - prevCpuTimes.idle;
    const totalDiff = currentTimes.total - prevCpuTimes.total;
    const usage = totalDiff > 0 ? ((1 - idleDiff / totalDiff) * 100) : 0;
    prevCpuTimes = currentTimes;
    return Math.round(usage * 10) / 10;
  }
  
  prevCpuTimes = currentTimes;
  return 0;
};

const getNetworkStats = () => {
  try {
    const interfaces = os.networkInterfaces();
    // Try reading /proc/net/dev for actual bytes (Linux only)
    if (fs.existsSync('/proc/net/dev')) {
      const content = fs.readFileSync('/proc/net/dev', 'utf8');
      const lines = content.split('\n').slice(2); // Skip headers
      let totalRx = 0, totalTx = 0;
      lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 10 && !parts[0].startsWith('lo:')) {
          totalRx += parseInt(parts[1]) || 0;
          totalTx += parseInt(parts[9]) || 0;
        }
      });
      
      const current = { rx: totalRx, tx: totalTx, time: Date.now() };
      
      if (prevNetStats) {
        const elapsed = (current.time - prevNetStats.time) / 1000;
        const rxRate = elapsed > 0 ? ((current.rx - prevNetStats.rx) / elapsed / 1024 / 1024) : 0; // MB/s
        const txRate = elapsed > 0 ? ((current.tx - prevNetStats.tx) / elapsed / 1024 / 1024) : 0; // MB/s
        prevNetStats = current;
        return {
          rxMbps: Math.round(rxRate * 100) / 100,
          txMbps: Math.round(txRate * 100) / 100
        };
      }
      
      prevNetStats = current;
      return { rxMbps: 0, txMbps: 0 };
    }
    
    return { rxMbps: 0, txMbps: 0 };
  } catch (e) {
    return { rxMbps: 0, txMbps: 0 };
  }
};

app.get('/api/metrics', (req, res) => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    const cpuUsage = getCpuUsage();
    const network = getNetworkStats();
    
    res.json({
      timestamp: Date.now(),
      cpu: {
        usage: cpuUsage,
        cores: os.cpus().length
      },
      memory: {
        total: Math.round(totalMem / 1024 / 1024), // MB
        used: Math.round(usedMem / 1024 / 1024),
        free: Math.round(freeMem / 1024 / 1024),
        percent: Math.round((usedMem / totalMem) * 1000) / 10
      },
      network: {
        rxMbps: network.rxMbps,
        txMbps: network.txMbps
      },
      uptime: os.uptime(),
      loadAvg: os.loadavg()
    });
  } catch (error) {
    // Nunca devolver 500 al dashboard de métricas
    res.status(200).json({
      timestamp: Date.now(),
      cpu: { usage: 0, cores: 0 },
      memory: { total: 0, used: 0, free: 0, percent: 0 },
      network: { rxMbps: 0, txMbps: 0 },
      uptime: 0,
      loadAvg: [0, 0, 0],
      degraded: true,
      reason: 'metrics_unavailable'
    });
  }
});

// Ruta catch-all para servir la aplicación React (debe ir después de todas las rutas API)
app.use((req, res, next) => {
  // Solo servir index.html para rutas que no sean archivos estáticos
  if (!req.path.includes('.')) {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  } else {
    next();
  }
});

// Manejo de cierre limpio
process.on('SIGINT', () => {
  sendLog('system', 'warn', 'Cerrando servidor...');
  ffmpegProcesses.forEach((processData, processId) => {
    if (processData.process && !processData.process.killed) {
      sendLog(processId, 'warn', `Deteniendo ffmpeg por cierre del servidor`);
      processData.process.kill('SIGTERM');
    }
  });
  process.exit(0);
});

process.on('SIGTERM', () => {
  sendLog('system', 'warn', 'Recibida señal SIGTERM, cerrando servidor...');
  ffmpegProcesses.forEach((processData, processId) => {
    if (processData.process && !processData.process.killed) {
      sendLog(processId, 'warn', `Deteniendo ffmpeg por SIGTERM`);
      processData.process.kill('SIGTERM');
    }
  });
  process.exit(0);
});

// ====== NIGHT REST SCHEDULER ======
// Checks every minute if any process with night_rest=true needs to stop (1AM) or start (5AM)
// Uses Costa Rica time (UTC-6) for scheduling
// nightRestStoppedProcesses is declared at top with other global Sets
function getCostaRicaHour() {
  const now = new Date();
  // Costa Rica is UTC-6 (no daylight saving)
  const utcHours = now.getUTCHours();
  const crHour = (utcHours - 6 + 24) % 24;
  return { hour: crHour, minute: now.getUTCMinutes() };
}

setInterval(async () => {
  if (!supabase) return;
  
  const { hour, minute } = getCostaRicaHour();
  
  // Only act at exact hour transitions (minute 0) to avoid repeated actions
  if (minute !== 0) return;
  
  try {
    const { data: rows, error } = await supabase
      .from('emission_processes')
      .select('id, night_rest, is_emitting, emit_status, m3u8, rtmp, source_url')
      .eq('night_rest', true);
    
    if (error || !rows) return;
    
    for (const row of rows) {
      const pid = String(row.id);
      
      // 1 AM: Stop processes that are emitting
      if (hour === 1 && row.is_emitting) {
        sendLog(pid, 'info', `🌙 Descanso nocturno: Apagando ${CHANNEL_CONFIGS_SERVER[pid] || `Proceso ${pid}`} hasta las 5AM...`);
        nightRestStoppedProcesses.add(pid);
        manualStopProcesses.add(pid);
        manualStopProcesses.add(Number(pid));
        
        // Kill the FFmpeg process
        const processData = ffmpegProcesses.get(pid) || ffmpegProcesses.get(Number(pid));
        if (processData && processData.process && !processData.process.killed) {
          processData.process.kill('SIGTERM');
        }
        
        // Update DB
        await supabase.from('emission_processes').update({
          is_emitting: false,
          is_active: false,
          emit_status: 'idle',
          emit_msg: '🌙 Descanso nocturno (se enciende a las 5AM)',
        }).eq('id', row.id);
        
        sendLog(pid, 'success', `🌙 Proceso apagado por descanso nocturno`);
      }
      
      // 5 AM: Start processes that were stopped by night rest
      if (hour === 5 && !row.is_emitting && nightRestStoppedProcesses.has(pid)) {
        nightRestStoppedProcesses.delete(pid);
        manualStopProcesses.delete(pid);
        manualStopProcesses.delete(Number(pid));
        
        sendLog(pid, 'info', `☀️ Descanso nocturno terminado: Encendiendo ${CHANNEL_CONFIGS_SERVER[pid] || `Proceso ${pid}`}...`);
        
        // TDMax channels need a fresh URL via scraping
        if (CHANNEL_MAP[pid]) {
          const { channelId, channelName } = CHANNEL_MAP[pid];
          sendLog(pid, 'info', `🔄 ${channelName}: Obteniendo URL fresca para arranque matutino...`);
          await autoRecoverChannel(pid, channelId, channelName);
        } else if (MANUAL_URL_PROCESSES.has(pid)) {
          // Disney/Canal 6: restart with existing URL from DB
          const sourceUrl = row.source_url || row.m3u8;
          const targetRtmp = row.rtmp;
          
          if (sourceUrl && targetRtmp) {
            sendLog(pid, 'info', `🔄 Reiniciando con URL existente...`);
            await supabase.from('emission_processes').update({
              emit_status: 'starting',
              is_emitting: true,
              is_active: true,
            }).eq('id', row.id);
            
            try {
              await fetch(`http://localhost:${PORT}/api/emit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  source_m3u8: sourceUrl,
                  target_rtmp: targetRtmp,
                  process_id: pid,
                  is_recovery: true,
                }),
              });
            } catch (err) {
              sendLog(pid, 'error', `❌ Error al arrancar: ${err.message}`);
            }
          } else {
            sendLog(pid, 'warn', `⚠️ No hay URL guardada para arrancar automáticamente`);
          }
        }
      }
    }
  } catch (err) {
    console.error('Night rest scheduler error:', err);
  }
}, 60000); // Check every minute

// Server-side channel name map for logs
const CHANNEL_CONFIGS_SERVER = {
  '0': 'Disney 7', '1': 'FUTV', '3': 'TDmas 1', '4': 'Teletica',
  '5': 'Canal 6', '6': 'Multimedios', '7': 'Subida', '10': 'Disney 8',
};

// Endpoint para toggle night_rest
app.post('/api/night-rest', async (req, res) => {
  try {
    const { process_id, enabled } = req.body;
    if (process_id === undefined || enabled === undefined) {
      return res.status(400).json({ error: 'Faltan parámetros: process_id, enabled' });
    }
    
    if (!supabase) {
      return res.status(500).json({ error: 'Base de datos no disponible' });
    }
    
    const { error } = await supabase
      .from('emission_processes')
      .update({ night_rest: enabled })
      .eq('id', Number(process_id));
    
    if (error) throw error;
    
    const label = CHANNEL_CONFIGS_SERVER[String(process_id)] || `Proceso ${process_id}`;
    sendLog(String(process_id), 'info', `${enabled ? '🌙' : '☀️'} Descanso nocturno ${enabled ? 'activado' : 'desactivado'} para ${label}`);
    
    if (!enabled) {
      nightRestStoppedProcesses.delete(String(process_id));
    }
    
    res.json({ success: true, night_rest: enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Iniciar el servidor HTTP (que incluye WebSocket)
server.listen(PORT, () => {
  console.log(`🚀 Servidor HTTP+WebSocket iniciado en puerto ${PORT}`);
  console.log(`📡 Panel disponible en: http://localhost:${PORT}`);
  console.log(`🔧 Asegúrate de tener FFmpeg instalado y accesible en PATH`);  
  console.log(`📋 WebSocket logs disponibles en: ws://localhost:${PORT}/ws`);
  sendLog('system', 'success', `Servidor iniciado en puerto ${PORT}`);
});