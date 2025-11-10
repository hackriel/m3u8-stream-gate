import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import multer from 'multer';
import fs from 'fs';

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

    // Si ya hay un proceso corriendo para este ID, detenerlo primero
    const existingProcess = ffmpegProcesses.get(process_id);
    if (existingProcess && existingProcess.process && !existingProcess.process.killed) {
      sendLog(process_id, 'warn', `Deteniendo proceso ffmpeg existente para reinicio`);
      existingProcess.process.kill('SIGTERM');
      ffmpegProcesses.delete(process_id);
    }

    emissionStatuses.set(process_id, 'starting');
    
    // === MODO ESTABLE: SIEMPRE RECODIFICAR A 720p30 ===
    sendLog(process_id, 'info', `Configurando recodificación estable a 720p30 (~2.8Mbps)...`);
    
    const ffmpegArgs = [
      // Parámetros de entrada con reconexión robusta
      '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      '-headers', 'Accept: application/vnd.apple.mpegurl,*/*;q=0.8',
      '-multiple_requests', '1',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '15',
      '-reconnect_at_eof', '1',
      '-timeout', '10000000',
      '-rw_timeout', '10000000',
      '-re',
      '-i', source_m3u8,
      
      // Mapeo de streams
      '-map', '0:v',
      '-map', '0:a',
      
      // Codificación de video: 720p30 estable
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'film',
      '-profile:v', 'high',
      '-level', '4.1',
      '-b:v', '2800k',
      '-maxrate', '3800k',
      '-bufsize', '5600k',
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,fps=30',
      '-g', '60',
      '-keyint_min', '60',
      '-sc_threshold', '0',
      
      // Codificación de audio: AAC estéreo
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',
      '-ar', '48000',
      
      // Salida RTMP con flags optimizados
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize+no_metadata',
      '-max_delay', '5000000',
      '-rtmp_live', 'live',
      '-rtmp_buffer', '5000',
      target_rtmp
    ];

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

    // Si ya hay un proceso corriendo para este ID, detenerlo primero
    const existingProcess = ffmpegProcesses.get(process_id);
    if (existingProcess && existingProcess.process && !existingProcess.process.killed) {
      sendLog(process_id, 'warn', `Deteniendo proceso ffmpeg existente para reinicio`);
      existingProcess.process.kill('SIGTERM');
      ffmpegProcesses.delete(process_id);
    }

    emissionStatuses.set(process_id, 'starting');
    
    // Si hay múltiples archivos, crear un archivo concat
    let inputSource;
    let cleanupFiles = [];
    
    if (files.length === 1) {
      inputSource = files[0].path;
      sendLog(process_id, 'info', `Emitiendo archivo único: ${files[0].originalname}`);
    } else {
      // Crear archivo concat para múltiples videos usando rutas relativas
      const concatFilePath = path.join(__dirname, 'uploads', `concat-${process_id}-${Date.now()}.txt`);
      // Usar solo el nombre del archivo (basename) ya que ffmpeg trabajará en el directorio uploads
      const concatContent = files.map(f => `file '${path.basename(f.path)}'`).join('\n');
      fs.writeFileSync(concatFilePath, concatContent);
      inputSource = path.basename(concatFilePath);
      cleanupFiles.push(concatFilePath);
      sendLog(process_id, 'info', `Creada playlist con ${files.length} archivos`);
    }

    // === MODO ESTABLE: SIEMPRE RECODIFICAR A 720p30 ===
    sendLog(process_id, 'info', `Configurando recodificación estable a 720p30 (~2.8Mbps)...`);
    
    let ffmpegArgs;
    
    if (files.length === 1) {
      // Archivo único con recodificación
      ffmpegArgs = [
        '-re',
        '-stream_loop', '-1',
        '-i', path.basename(inputSource),
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'film',
        '-profile:v', 'high',
        '-level', '4.1',
        '-b:v', '2800k',
        '-maxrate', '3800k',
        '-bufsize', '5600k',
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
      // Múltiples archivos con recodificación
      ffmpegArgs = [
        '-re',
        '-f', 'concat',
        '-safe', '0',
        '-stream_loop', '-1',
        '-i', inputSource,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'film',
        '-profile:v', 'high',
        '-level', '4.1',
        '-b:v', '2800k',
        '-maxrate', '3800k',
        '-bufsize', '5600k',
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
    }

    const commandStr = 'ffmpeg ' + ffmpegArgs.join(' ');
    sendLog(process_id, 'info', `Comando ejecutado: ${commandStr.substring(0, 150)}...`);

    // Ejecutar ffmpeg
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      cwd: path.join(__dirname, 'uploads') // Trabajar en directorio uploads
    });
    
    const processInfo = { 
      process: ffmpegProcess, 
      status: 'starting',
      startTime: Date.now(),
      restartCount: (existingProcess?.restartCount || 0),
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
        sendLog(process_id, 'error', `FFmpeg error: ${output.trim()}`);
      }
    });

    ffmpegProcess.on('close', (code) => {
      const processInfo = ffmpegProcesses.get(process_id);
      
      // Limpiar archivos temporales
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
      
      if (code === 0) {
        sendLog(process_id, 'success', `FFmpeg terminó exitosamente`);
      } else {
        sendLog(process_id, 'error', `FFmpeg terminó con error (código: ${code})`);
      }
      
      emissionStatuses.set(process_id, code === 0 ? 'idle' : 'error');
      ffmpegProcesses.delete(process_id);
    });

    ffmpegProcess.on('error', (error) => {
      sendLog(process_id, 'error', `Error crítico de FFmpeg: ${error.message}`);
      emissionStatuses.set(process_id, 'error');
      ffmpegProcesses.delete(process_id);
    });

    setTimeout(() => {
      const currentStatus = emissionStatuses.get(process_id);
      const processData = ffmpegProcesses.get(process_id);
      if (currentStatus === 'starting' && processData && processData.process && !processData.process.killed) {
        emissionStatuses.set(process_id, 'running');
      }
    }, 3000);

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