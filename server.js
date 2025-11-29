import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import multer from 'multer';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

// Configurar cliente de Supabase (opcional, solo si hay variables de entorno)
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

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
  // Detectar errores de fuente M3U8
  if (output.includes('Invalid data found') || 
      output.includes('Server returned 404') ||
      output.includes('Server returned 403') ||
      output.includes('Server returned 5') ||
      output.includes('Connection refused') && output.includes('http')) {
    const reason = output.includes('404') ? 'URL Fuente M3U8 no encontrada (404)' :
                   output.includes('403') ? 'URL Fuente M3U8 prohibida (403)' :
                   output.includes('Invalid data') ? 'URL Fuente M3U8 inválida o corrupta' :
                   'URL Fuente M3U8 no accesible';
    sendLog(processId, 'error', `ERROR DE FUENTE: ${reason}`);
    sendFailureNotification(processId, 'source', reason);
    return true;
  }
  
  // Detectar errores de destino RTMP
  if (output.includes('Connection to tcp://') && output.includes('failed') ||
      output.includes('RTMP handshake failed') ||
      output.includes('rtmp://') && output.includes('failed') ||
      output.includes('Server rejected') ||
      output.includes('Connection reset by peer') ||
      output.includes('Unable to publish')) {
    const reason = output.includes('Connection to tcp://') && output.includes('failed') ? 'Destino RTMP no responde o URL incorrecta' :
                   output.includes('RTMP handshake failed') ? 'Fallo en handshake RTMP (verificar URL)' :
                   output.includes('Server rejected') ? 'Servidor RTMP rechazó la conexión' :
                   output.includes('Connection reset') ? 'Conexión RTMP resetteada por el servidor' :
                   'No se pudo publicar al destino RTMP';
    sendLog(processId, 'error', `ERROR DE RTMP: ${reason}`);
    sendFailureNotification(processId, 'rtmp', reason);
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
    return true;
  }
  
  return false;
};

// Función auxiliar para detectar resolución de un M3U8
const detectM3U8Resolution = async (m3u8Url) => {
  return new Promise((resolve) => {
    const probe = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'json',
      m3u8Url
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
        resolve({ width, height });
      } catch (e) {
        resolve({ width: 0, height: 0 });
      }
    });
    
    probe.on('error', () => {
      resolve({ width: 0, height: 0 });
    });
  });
};

// Función auxiliar para detectar resolución de un archivo local
const detectFileResolution = async (filePath) => {
  return new Promise((resolve) => {
    const probe = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'json',
      filePath
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
        resolve({ width, height });
      } catch (e) {
        resolve({ width: 0, height: 0 });
      }
    });
    
    probe.on('error', () => {
      resolve({ width: 0, height: 0 });
    });
  });
};

// Endpoint para iniciar emisión
app.post('/api/emit', async (req, res) => {
  try {
    const { source_m3u8, target_rtmp, process_id = '0' } = req.body;

    sendLog(process_id, 'info', `Nueva solicitud de emisión recibida`, { source_m3u8, target_rtmp });

    // Validaciones
    if (!source_m3u8 || !target_rtmp) {
      sendLog(process_id, 'error', 'Faltan parámetros requeridos: source_m3u8 y target_rtmp');
      return res.status(400).json({ 
        error: 'Faltan parámetros requeridos: source_m3u8 y target_rtmp' 
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
        conflictingProcess.process.kill('SIGTERM');
        ffmpegProcesses.delete(conflictingProcessId);
        emissionStatuses.set(conflictingProcessId, 'idle');
      }
    }

    // Si ya hay un proceso corriendo para este ID, detenerlo primero
    const existingProcess = ffmpegProcesses.get(process_id);
    if (existingProcess && existingProcess.process && !existingProcess.process.killed) {
      sendLog(process_id, 'warn', `Deteniendo proceso ffmpeg existente para reinicio`);
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
            emit_status: 'stopped'
          })
          .eq('id', parseInt(process_id))
          .eq('is_emitting', true);
      }
    }

    emissionStatuses.set(process_id, 'starting');
    
    // Crear o actualizar registro en base de datos (solo si Supabase está disponible)
    let dbRecord = null;
    if (supabase) {
      const { data, error: dbError } = await supabase
        .from('emission_processes')
        .upsert({
          id: parseInt(process_id),
          m3u8: source_m3u8,
          rtmp: target_rtmp,
          is_active: true,
          is_emitting: true,
          emit_status: 'starting',
          start_time: Date.now(),
          process_logs: `[${new Date().toISOString()}] Iniciando emisión desde M3U8\n`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'id' })
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
    
    // Detectar resolución para optimizar CPU
    // OPTIMIZACIÓN: Solo detectamos resolución si realmente es necesario
    sendLog(process_id, 'info', `Verificando resolución de la fuente...`);
    const resolution = await detectM3U8Resolution(source_m3u8);
    const needsRecode = resolution.height > 720;
    
    let ffmpegArgs;
    
    if (needsRecode) {
      // Recodificación estable: preset fast + CBR + baseline profile
      sendLog(process_id, 'info', `Fuente es ${resolution.width}x${resolution.height}, recodificando a 720p30 (modo estable)...`);
      ffmpegArgs = [
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '10', // Aumentado de 5 a 10 segundos para reducir requests
        '-reconnect_at_eof', '1',
        '-multiple_requests', '0', // Evitar múltiples requests paralelos
        '-re',
        '-i', source_m3u8,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-profile:v', 'baseline',
        '-b:v', '2500k',
        '-minrate', '2500k',
        '-maxrate', '2500k',
        '-bufsize', '5000k',
        '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,fps=30',
        '-g', '60',
        '-keyint_min', '60',
        '-sc_threshold', '0',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ac', '2',
        '-ar', '48000',
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize',
        target_rtmp
      ];
    } else {
      // Copy directo - MUY bajo CPU (8-10%) - Optimizado para evitar múltiples requests
      sendLog(process_id, 'info', `Fuente es ${resolution.width}x${resolution.height}, usando copy (bajo CPU)...`);
      ffmpegArgs = [
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '10', // Aumentado de 5 a 10 segundos para reducir requests
        '-reconnect_at_eof', '1',
        '-multiple_requests', '0', // Evitar múltiples requests paralelos
        '-re',
        '-i', source_m3u8,
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize',
        target_rtmp
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
      target_rtmp: target_rtmp
    };
    ffmpegProcesses.set(process_id, processInfo);

    // Manejar salida estándar
    ffmpegProcess.stdout.on('data', (data) => {
      const output = data.toString();
      sendLog(process_id, 'info', `FFmpeg stdout: ${output.trim()}`);
    });

    // Manejar errores con análisis mejorado
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      
      // Detectar diferentes tipos de mensajes
      if (output.includes('frame=') || output.includes('fps=')) {
        // Progreso normal
        const currentStatus = emissionStatuses.get(process_id);
        if (currentStatus === 'starting') {
          emissionStatuses.set(process_id, 'running');
          sendLog(process_id, 'success', `Emisión iniciada exitosamente`);
        }
        
        // Extraer estadísticas básicas del progreso
        const frameMatch = output.match(/frame=\s*(\d+)/);
        const fpsMatch = output.match(/fps=\s*([\d.]+)/);
        const bitrateMatch = output.match(/bitrate=\s*([\d.]+)kbits\/s/);
        
        if (frameMatch && fpsMatch) {
          sendLog(process_id, 'info', `Progreso: frame=${frameMatch[1]}, fps=${fpsMatch[1]}, bitrate=${bitrateMatch ? bitrateMatch[1] + 'kbps' : 'N/A'}`);
        }
      } else if (output.includes('error') || output.includes('Error') || output.includes('failed') || output.includes('Failed')) {
        // Error detectado - categorizar y notificar
        const wasHandled = detectAndCategorizeError(output, process_id);
        if (!wasHandled) {
          sendLog(process_id, 'error', `FFmpeg error: ${output.trim()}`);
        }
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
    ffmpegProcess.on('close', async (code) => {
      const processInfo = ffmpegProcesses.get(process_id);
      const runtime = processInfo ? Date.now() - processInfo.startTime : 0;
      
      const finalStatus = code === 0 ? 'stopped' : 'error';
      const logMessage = code === 0 
        ? `FFmpeg terminó exitosamente (código: ${code}, runtime: ${Math.floor(runtime/1000)}s)`
        : `FFmpeg terminó con error (código: ${code}, runtime: ${Math.floor(runtime/1000)}s)`;
      
      if (code === 0) {
        sendLog(process_id, 'success', logMessage);
      } else {
        sendLog(process_id, 'error', logMessage);
        sendFailureNotification(process_id, 'server', `Proceso terminado con código de error ${code}`);
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
            elapsed: Math.floor(runtime / 1000)
          })
          .eq('id', parseInt(process_id));
      }
      
      emissionStatuses.set(process_id, 'idle');
      ffmpegProcesses.delete(process_id);
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
            process_logs: `[${new Date().toISOString()}] Error crítico: ${error.message}\n`
          })
          .eq('id', parseInt(process_id));
      }
      
      emissionStatuses.set(process_id, 'error');
      ffmpegProcesses.delete(process_id);
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
      status: 'starting'
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
        conflictingProcess.process.kill('SIGTERM');
        ffmpegProcesses.delete(conflictingProcessId);
        emissionStatuses.set(conflictingProcessId, 'idle');
      }
    }

    // Si ya hay un proceso corriendo para este ID, detenerlo primero
    const existingProcess = ffmpegProcesses.get(process_id);
    if (existingProcess && existingProcess.process && !existingProcess.process.killed) {
      sendLog(process_id, 'warn', `Deteniendo proceso ffmpeg existente para reinicio`);
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
            emit_status: 'stopped'
          })
          .eq('id', parseInt(process_id))
          .eq('is_emitting', true);
      }
    }

    emissionStatuses.set(process_id, 'starting');
    
    // Crear o actualizar registro en base de datos
    const fileNames = files.map(f => f.originalname).join(', ');
    const { data: dbRecord, error: dbError } = await supabase
      .from('emission_processes')
      .upsert({
        id: parseInt(process_id),
        m3u8: `Archivos: ${fileNames}`,
        rtmp: target_rtmp,
        is_active: true,
        is_emitting: true,
        emit_status: 'starting',
        start_time: Date.now(),
        process_logs: `[${new Date().toISOString()}] Iniciando emisión desde archivos locales: ${fileNames}\n`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' })
      .select()
      .single();
    
    if (dbError) {
      sendLog(process_id, 'warn', `Error guardando en DB: ${dbError.message}`);
    } else {
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

    // Detectar resolución del primer archivo para optimizar CPU
    sendLog(process_id, 'info', `Detectando resolución...`);
    const firstFilePath = files[0].path;
    const resolution = await detectFileResolution(firstFilePath);
    const needsRecode = resolution.height > 720;
    
    let ffmpegArgs;
    
    if (files.length === 1) {
      if (needsRecode) {
        sendLog(process_id, 'info', `Archivo ${resolution.width}x${resolution.height}, recodificando a 720p30 (modo estable)...`);
        ffmpegArgs = [
          '-re',
          '-stream_loop', '-1',
          '-i', path.basename(inputSource),
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-profile:v', 'baseline',
          '-b:v', '2500k',
          '-minrate', '2500k',
          '-maxrate', '2500k',
          '-bufsize', '5000k',
          '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,fps=30',
          '-g', '60',
          '-keyint_min', '60',
          '-sc_threshold', '0',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ac', '2',
          '-ar', '48000',
          '-f', 'flv',
          target_rtmp
        ];
      } else {
        sendLog(process_id, 'info', `Archivo ${resolution.width}x${resolution.height}, usando copy (bajo CPU)...`);
        ffmpegArgs = [
          '-re',
          '-stream_loop', '-1',
          '-i', path.basename(inputSource),
          '-c:v', 'copy',
          '-c:a', 'copy',
          '-f', 'flv',
          target_rtmp
        ];
      }
    } else {
      if (needsRecode) {
        sendLog(process_id, 'info', `Archivos ~${resolution.width}x${resolution.height}, recodificando a 720p30 (modo estable)...`);
        ffmpegArgs = [
          '-re',
          '-f', 'concat',
          '-safe', '0',
          '-stream_loop', '-1',
          '-i', inputSource,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-profile:v', 'baseline',
          '-b:v', '2500k',
          '-minrate', '2500k',
          '-maxrate', '2500k',
          '-bufsize', '5000k',
          '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,fps=30',
          '-g', '60',
          '-keyint_min', '60',
          '-sc_threshold', '0',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ac', '2',
        '-ar', '48000',
        '-f', 'flv',
        target_rtmp
      ];
      } else {
        sendLog(process_id, 'info', `Archivos ~${resolution.width}x${resolution.height}, usando copy (bajo CPU)...`);
        ffmpegArgs = [
          '-re',
          '-f', 'concat',
          '-safe', '0',
          '-stream_loop', '-1',
          '-i', inputSource,
          '-c:v', 'copy',
          '-c:a', 'copy',
          '-f', 'flv',
          target_rtmp
        ];
      }
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
          sendLog(process_id, 'info', `Progreso: frame=${frameMatch[1]}, fps=${fpsMatch[1]}`);
        }
      } else if (output.includes('error') || output.includes('Error')) {
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
            elapsed: Math.floor(runtime / 1000)
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
            process_logs: `[${new Date().toISOString()}] Error crítico: ${error.message}\n`
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

// Endpoint para emitir desde YouTube usando yt-dlp
app.post('/api/emit/youtube', async (req, res) => {
  try {
    const { youtube_url, target_rtmp, process_id = '4' } = req.body;

    sendLog(process_id, 'info', `Nueva solicitud de emisión desde YouTube`, { youtube_url, target_rtmp });

    // Validaciones
    if (!youtube_url || !target_rtmp) {
      sendLog(process_id, 'error', 'Faltan parámetros requeridos: youtube_url y target_rtmp');
      return res.status(400).json({ 
        error: 'Faltan parámetros requeridos: youtube_url y target_rtmp' 
      });
    }

    // Validar que sea una URL de YouTube válida
    if (!youtube_url.includes('youtube.com') && !youtube_url.includes('youtu.be')) {
      sendLog(process_id, 'error', 'URL no válida: debe ser una URL de YouTube');
      return res.status(400).json({ 
        error: 'URL no válida: debe ser una URL de YouTube' 
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
        conflictingProcess.process.kill('SIGTERM');
        ffmpegProcesses.delete(conflictingProcessId);
        emissionStatuses.set(conflictingProcessId, 'idle');
      }
    }

    // Si ya hay un proceso corriendo para este ID, detenerlo primero
    const existingProcess = ffmpegProcesses.get(process_id);
    if (existingProcess && existingProcess.process && !existingProcess.process.killed) {
      sendLog(process_id, 'warn', `Deteniendo proceso ffmpeg existente para reinicio`);
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
            emit_status: 'stopped'
          })
          .eq('id', parseInt(process_id))
          .eq('is_emitting', true);
      }
    }

    emissionStatuses.set(process_id, 'starting');
    
    // Crear o actualizar registro en base de datos (solo si Supabase está disponible)
    if (supabase) {
      const { data, error: dbError } = await supabase
        .from('emission_processes')
        .upsert({
          id: parseInt(process_id),
          m3u8: `YouTube: ${youtube_url}`,
          rtmp: target_rtmp,
          is_active: true,
          is_emitting: true,
          emit_status: 'starting',
          start_time: Date.now(),
          process_logs: `[${new Date().toISOString()}] Iniciando emisión desde YouTube\n`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'id' })
        .select()
        .single();

      if (dbError) {
        sendLog(process_id, 'warn', `Error guardando en DB: ${dbError.message}`);
      } else {
        sendLog(process_id, 'info', `✅ Proceso guardado en base de datos (ID: ${process_id})`);
      }
    }
    
    sendLog(process_id, 'info', `Extrayendo URL del stream de YouTube con yt-dlp...`);
    
    // Usar yt-dlp para obtener la URL del stream en la máxima calidad
    // Formato: bestvideo+bestaudio para obtener la mejor calidad de video y audio
    const ytdlp = spawn('yt-dlp', [
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '-g',
      youtube_url
    ]);
    
    let streamUrl = '';
    let ytdlpError = '';
    
    ytdlp.stdout.on('data', (data) => {
      const output = data.toString().trim();
      if (output && output.startsWith('http')) {
        // yt-dlp puede devolver dos URLs (video y audio separados) o una sola
        // Tomamos la primera URL que es la de video
        if (!streamUrl) {
          streamUrl = output.split('\n')[0];
        }
      }
    });
    
    ytdlp.stderr.on('data', (data) => {
      ytdlpError += data.toString();
    });
    
    ytdlp.on('close', async (code) => {
      if (code !== 0 || !streamUrl) {
        const errorMsg = `Error extrayendo stream de YouTube: ${ytdlpError || 'URL no encontrada'}`;
        sendLog(process_id, 'error', errorMsg);
        sendFailureNotification(process_id, 'source', errorMsg);
        
        if (supabase) {
          await supabase
            .from('emission_processes')
            .update({
              is_active: false,
              is_emitting: false,
              emit_status: 'error',
              ended_at: new Date().toISOString(),
              failure_reason: 'source',
              failure_details: errorMsg
            })
            .eq('id', parseInt(process_id));
        }
        
        emissionStatuses.set(process_id, 'error');
        return;
      }
      
      sendLog(process_id, 'success', `Stream de YouTube extraído exitosamente`);
      sendLog(process_id, 'info', `Iniciando transmisión a RTMP...`);
      
      // Ahora usar FFmpeg para transmitir el stream de YouTube al RTMP
      // Usamos copy para mantener la calidad original sin recodificar
      const ffmpegArgs = [
        '-re',
        '-i', streamUrl,
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize',
        target_rtmp
      ];
      
      const commandStr = 'ffmpeg ' + ffmpegArgs.join(' ');
      sendLog(process_id, 'info', `Comando ejecutado: ${commandStr.substring(0, 100)}...`);
      
      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
      const processInfo = { 
        process: ffmpegProcess, 
        status: 'starting',
        startTime: Date.now(),
        target_rtmp: target_rtmp
      };
      ffmpegProcesses.set(process_id, processInfo);
      
      // Manejar salida de FFmpeg (reutilizar lógica existente)
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
            sendLog(process_id, 'success', `Emisión de YouTube iniciada exitosamente`);
          }
          
          const frameMatch = output.match(/frame=\s*(\d+)/);
          const fpsMatch = output.match(/fps=\s*([\d.]+)/);
          const bitrateMatch = output.match(/bitrate=\s*([\d.]+)kbits\/s/);
          
          if (frameMatch && fpsMatch) {
            sendLog(process_id, 'info', `Progreso: frame=${frameMatch[1]}, fps=${fpsMatch[1]}, bitrate=${bitrateMatch ? bitrateMatch[1] + 'kbps' : 'N/A'}`);
          }
        } else if (output.includes('error') || output.includes('Error') || output.includes('failed') || output.includes('Failed')) {
          const wasHandled = detectAndCategorizeError(output, process_id);
          if (!wasHandled) {
            sendLog(process_id, 'error', `FFmpeg error: ${output.trim()}`);
          }
        } else if (output.includes('warning') || output.includes('Warning')) {
          sendLog(process_id, 'warn', `FFmpeg warning: ${output.trim()}`);
        } else {
          if (output.includes('Stream #') || output.includes('Input #') || output.includes('Output #')) {
            sendLog(process_id, 'info', `FFmpeg: ${output.trim()}`);
          }
        }
      });
      
      ffmpegProcess.on('close', async (code) => {
        const processInfo = ffmpegProcesses.get(process_id);
        const runtime = processInfo ? Date.now() - processInfo.startTime : 0;
        
        const finalStatus = code === 0 ? 'stopped' : 'error';
        const logMessage = code === 0 
          ? `FFmpeg terminó exitosamente (código: ${code}, runtime: ${Math.floor(runtime/1000)}s)`
          : `FFmpeg terminó con error (código: ${code}, runtime: ${Math.floor(runtime/1000)}s)`;
        
        if (code === 0) {
          sendLog(process_id, 'success', logMessage);
        } else {
          sendLog(process_id, 'error', logMessage);
          sendFailureNotification(process_id, 'server', `Proceso terminado con código de error ${code}`);
        }
        
        if (supabase) {
          await supabase
            .from('emission_processes')
            .update({
              is_active: false,
              is_emitting: false,
              emit_status: finalStatus,
              ended_at: new Date().toISOString(),
              process_logs: `[${new Date().toISOString()}] ${logMessage}\n`,
              elapsed: Math.floor(runtime / 1000)
            })
            .eq('id', parseInt(process_id));
        }
        
        emissionStatuses.set(process_id, 'idle');
        ffmpegProcesses.delete(process_id);
      });
      
      ffmpegProcess.on('error', async (error) => {
        sendLog(process_id, 'error', `Error crítico de FFmpeg: ${error.message}`, { error: error.toString() });
        sendFailureNotification(process_id, 'server', `Error crítico del servidor: ${error.message}`);
        
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
              process_logs: `[${new Date().toISOString()}] Error crítico: ${error.message}\n`
            })
            .eq('id', parseInt(process_id));
        }
        
        emissionStatuses.set(process_id, 'error');
        ffmpegProcesses.delete(process_id);
      });
      
      setTimeout(() => {
      }, 2000);
    });
    
    ytdlp.on('error', async (error) => {
      const errorMsg = `Error ejecutando yt-dlp: ${error.message}. Asegúrate de que yt-dlp está instalado.`;
      sendLog(process_id, 'error', errorMsg);
      
      if (supabase) {
        await supabase
          .from('emission_processes')
          .update({
            is_active: false,
            is_emitting: false,
            emit_status: 'error',
            ended_at: new Date().toISOString(),
            failure_reason: 'server',
            failure_details: errorMsg
          })
          .eq('id', parseInt(process_id));
      }
      
      emissionStatuses.set(process_id, 'error');
      return res.status(500).json({ 
        error: 'Error con yt-dlp', 
        details: errorMsg 
      });
    });

    res.json({ 
      success: true, 
      message: 'Extrayendo stream de YouTube...',
      status: 'starting'
    });

  } catch (error) {
    console.error(`❌ Error en /api/emit/youtube [${req.body.process_id || '4'}]:`, error);
    emissionStatuses.set(req.body.process_id || '4', 'error');
    res.status(500).json({ 
      error: 'Error interno del servidor', 
      details: error.message 
    });
  }
});

// Endpoint para detener emisión
app.post('/api/emit/stop', async (req, res) => {
  try {
    const { process_id = '0' } = req.body;
    sendLog(process_id, 'info', `Solicitada detención de emisión`);
    
    const processData = ffmpegProcesses.get(process_id);
    if (processData && processData.process && !processData.process.killed) {
      emissionStatuses.set(process_id, 'stopping');
      
      // Actualizar base de datos antes de detener (solo si Supabase está disponible)
      if (supabase) {
        await supabase
          .from('emission_processes')
          .update({
            is_active: false,
            is_emitting: false,
            emit_status: 'stopped',
            ended_at: new Date().toISOString(),
            process_logs: `[${new Date().toISOString()}] Emisión detenida manualmente\n`
          })
          .eq('id', parseInt(process_id));
      }
      
      // Intentar terminar graciosamente
      processData.process.kill('SIGTERM');
      
      // Si no termina en 5 segundos, forzar terminación
      setTimeout(() => {
        const currentProcessData = ffmpegProcesses.get(process_id);
        if (currentProcessData && currentProcessData.process && !currentProcessData.process.killed) {
          sendLog(process_id, 'warn', `Forzando terminación de ffmpeg`);
          currentProcessData.process.kill('SIGKILL');
        }
      }, 5000);
      
      ffmpegProcesses.delete(process_id);
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
    sendLog(process_id || '0', 'error', `Error deteniendo emisión: ${error.message}`);
    res.status(500).json({ 
      error: 'Error interno del servidor', 
      details: error.message 
    });
  }
});

// Nuevo endpoint para eliminar completamente un proceso específico de la base de datos
app.delete('/api/emit/:process_id', async (req, res) => {
  try {
    const { process_id } = req.params;
    sendLog(process_id, 'info', `Solicitada eliminación del proceso ${process_id}`);
    
    // Primero detener el proceso si está corriendo
    const processData = ffmpegProcesses.get(process_id);
    if (processData && processData.process && !processData.process.killed) {
      processData.process.kill('SIGKILL');
      ffmpegProcesses.delete(process_id);
      emissionStatuses.set(process_id, 'idle');
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

// Endpoint para verificar estado
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
    for (let i = 0; i < 4; i++) {
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

// Servir archivos estáticos de React en producción
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// === TAREA PROGRAMADA: Limpieza de caché diaria a las 4am Costa Rica ===
const scheduleCacheClear = () => {
  const checkAndClear = () => {
    const now = new Date();
    // Costa Rica es UTC-6
    const costaRicaTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Costa_Rica' }));
    const hour = costaRicaTime.getHours();
    const minute = costaRicaTime.getMinutes();
    
    // Ejecutar entre 4:00am y 4:05am
    if (hour === 4 && minute < 5) {
      const lastCleared = global.lastCacheClear || 0;
      const hoursSinceLastClear = (Date.now() - lastCleared) / (1000 * 60 * 60);
      
      // Solo ejecutar si han pasado más de 12 horas desde la última limpieza
      if (hoursSinceLastClear > 12) {
        sendLog('system', 'info', '🧹 Iniciando limpieza programada de caché (4am Costa Rica)');
        
        // Limpiar cookies y caché del navegador (localStorage se limpia en cliente)
        if (global.gc) {
          global.gc();
          sendLog('system', 'success', 'Garbage collector ejecutado');
        }
        
        // Marcar timestamp de limpieza
        global.lastCacheClear = Date.now();
        sendLog('system', 'success', '✅ Limpieza de caché completada');
      }
    }
  };
  
  // Verificar cada minuto
  setInterval(checkAndClear, 60 * 1000);
  sendLog('system', 'info', '⏰ Tarea programada activada: Limpieza de caché diaria a las 4am Costa Rica');
};

scheduleCacheClear();

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

// Iniciar el servidor HTTP (que incluye WebSocket)
server.listen(PORT, () => {
  console.log(`🚀 Servidor HTTP+WebSocket iniciado en puerto ${PORT}`);
  console.log(`📡 Panel disponible en: http://localhost:${PORT}`);
  console.log(`🔧 Asegúrate de tener FFmpeg instalado y accesible en PATH`);  
  console.log(`📋 WebSocket logs disponibles en: ws://localhost:${PORT}/ws`);
  sendLog('system', 'success', `Servidor iniciado en puerto ${PORT}`);
});