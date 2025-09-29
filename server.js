import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

// Variables globales para manejo de múltiples procesos ffmpeg
const ffmpegProcesses = new Map(); // Map<processId, { process, status, startTime, restartCount }>
const emissionStatuses = new Map(); // Map<processId, status>

// Función mejorada para detectar problemas de RTMP
const detectRTMPIssues = (output, processId) => {
  const issues = [];
  
  if (output.includes('Connection to tcp://') && output.includes('failed')) {
    issues.push('Error de conexión TCP');
  }
  if (output.includes('RTMP handshake failed')) {
    issues.push('Fallo en handshake RTMP');
  }
  if (output.includes('Server rejected our application')) {
    issues.push('Servidor RTMP rechazó la aplicación');
  }
  if (output.includes('Stream key invalid')) {
    issues.push('Clave de stream inválida');
  }
  if (output.includes('Bandwidth limit exceeded')) {
    issues.push('Límite de ancho de banda excedido');
  }
  if (output.includes('Connection reset by peer')) {
    issues.push('Conexión resetteada por el servidor');
  }
  if (output.includes('I/O error')) {
    issues.push('Error de entrada/salida');
  }
  
  issues.forEach(issue => {
    sendLog(processId, 'error', `RTMP Issue: ${issue}`, { output: output.substring(0, 200) });
  });
  
  return issues.length > 0;
};

// Endpoint para iniciar emisión
app.post('/api/emit', (req, res) => {
  try {
    const { source_m3u8, target_rtmp, process_id = '0', custom_quality = false, video_bitrate = '2000k', video_resolution = '1920x1080' } = req.body;

    sendLog(process_id, 'info', `Nueva solicitud de emisión recibida`, { source_m3u8, target_rtmp, custom_quality });

    // Validaciones
    if (!source_m3u8 || !target_rtmp) {
      sendLog(process_id, 'error', 'Faltan parámetros requeridos: source_m3u8 y target_rtmp');
      return res.status(400).json({ 
        error: 'Faltan parámetros requeridos: source_m3u8 y target_rtmp' 
      });
    }

    // Si ya hay un proceso corriendo para este ID, detenerlo primero
    const existingProcess = ffmpegProcesses.get(process_id);
    if (existingProcess && existingProcess.process && !existingProcess.process.killed) {
      sendLog(process_id, 'warn', `Deteniendo proceso ffmpeg existente para reinicio`);
      existingProcess.process.kill('SIGTERM');
      ffmpegProcesses.delete(process_id);
    }

    emissionStatuses.set(process_id, 'starting');
    sendLog(process_id, 'info', `Iniciando proceso FFmpeg - Modo: ${custom_quality ? 'Personalizada' : 'Copia directa'}`);

    // Construir comando ffmpeg según configuración de calidad
    let ffmpegArgs;
    
    if (custom_quality) {
      // CONFIGURACIÓN ULTRA-BÁSICA QUE FUNCIONABA ANTES
      sendLog(process_id, 'info', `Iniciando recodificación básica: ${video_resolution} @ ${video_bitrate}`);
      
      ffmpegArgs = [
        '-i', source_m3u8,
        '-c:v', 'libx264',
        '-b:v', video_bitrate,
        '-s', video_resolution,
        '-c:a', 'aac',
        '-f', 'flv',
        target_rtmp
      ];
      
      sendLog(process_id, 'info', `Configuración ultra-básica aplicada`);
      
    } else {
      // MODO COPIA DIRECTA MEJORADO
      ffmpegArgs = [
        // === INPUT OPTIMIZATION ===
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        '-headers', 'Accept: application/vnd.apple.mpegurl,*/*;q=0.8',
        '-multiple_requests', '1',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '4', 
        '-reconnect_at_eof', '1',
        '-i', source_m3u8,
        
        // === STREAM COPY ===
        '-c:v', 'copy',
        '-c:a', 'copy',
        
        // === OUTPUT SETTINGS ===
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize+no_metadata',
        
        // === BUFFER Y SINCRONIZACIÓN ===
        '-fflags', '+genpts+flush_packets',
        '-avoid_negative_ts', 'make_zero',
        '-use_wallclock_as_timestamps', '1',
        
        // === RTMP ESPECÍFICO ===
        '-rtmp_live', 'live',
        '-rtmp_buffer', '1000',
        
        target_rtmp
      ];
      
      sendLog(process_id, 'info', 'Modo copia directa optimizado - Sin recodificación, máxima velocidad');
    }

    const commandStr = 'ffmpeg ' + ffmpegArgs.join(' ');
    sendLog(process_id, 'info', `Comando ejecutado: ${commandStr.substring(0, 100)}...`);

    // Ejecutar ffmpeg
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    const processInfo = { 
      process: ffmpegProcess, 
      status: 'starting',
      startTime: Date.now(),
      restartCount: (existingProcess?.restartCount || 0)
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
        // Error detectado
        const hasRTMPIssues = detectRTMPIssues(output, process_id);
        if (!hasRTMPIssues) {
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

    // Manejar cierre del proceso con análisis de código de salida
    ffmpegProcess.on('close', (code) => {
      const processInfo = ffmpegProcesses.get(process_id);
      const runtime = processInfo ? Date.now() - processInfo.startTime : 0;
      
      if (code === 0) {
        sendLog(process_id, 'success', `FFmpeg terminó exitosamente (código: ${code}, runtime: ${Math.floor(runtime/1000)}s)`);
        emissionStatuses.set(process_id, 'idle');
      } else {
        sendLog(process_id, 'error', `FFmpeg terminó con error (código: ${code}, runtime: ${Math.floor(runtime/1000)}s)`);
        emissionStatuses.set(process_id, 'error');
      }
      
      ffmpegProcesses.delete(process_id);
    });

    // Manejar error del proceso
    ffmpegProcess.on('error', (error) => {
      sendLog(process_id, 'error', `Error crítico de FFmpeg: ${error.message}`, { error: error.toString() });
      emissionStatuses.set(process_id, 'error');
      ffmpegProcesses.delete(process_id);
    });

    // Simular delay de inicio
    setTimeout(() => {
      const currentStatus = emissionStatuses.get(process_id);
      const processData = ffmpegProcesses.get(process_id);
      if (currentStatus === 'starting' && processData && processData.process && !processData.process.killed) {
        emissionStatuses.set(process_id, 'running');
      }
    }, 3000);

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

// Endpoint para detener emisión
app.post('/api/emit/stop', (req, res) => {
  try {
    const { process_id = '0' } = req.body;
    sendLog(process_id, 'info', `Solicitada detención de emisión`);
    
    const processData = ffmpegProcesses.get(process_id);
    if (processData && processData.process && !processData.process.killed) {
      emissionStatuses.set(process_id, 'stopping');
      
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
    for (let i = 0; i < 5; i++) {
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
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
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

export default app;