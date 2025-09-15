import express from 'express';
import cors from 'cors';
import { spawn, exec } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { promisify } from 'util';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const execAsync = promisify(exec);

const app = express();
const PORT = process.env.PORT || 3001;

// Variables para el proceso de streaming robusto
const streamingProcesses = new Map(); // Map<processId, { ytdlp: process, ffmpeg: process }>
const emissionStatuses = new Map(); // Map<processId, status>

// Middleware básico
app.use(cors({
  origin: '*',
  credentials: true
}));
app.use(express.json());
app.use(express.static(join(__dirname, 'dist')));

// Método robusto usando yt-dlp + ffmpeg pipeline
async function startRobustStream(source_m3u8, target_rtmp, user_agent, referer, process_id) {
  return new Promise((resolve, reject) => {
    console.log(`🚀 Iniciando stream robusto [${process_id}] con yt-dlp + ffmpeg pipeline`);
    
    // Configuración de yt-dlp para HLS con autenticación
    const ytdlpArgs = [
      '--quiet',
      '--no-warnings',
      '--format', 'best[ext=mp4]/best',
      '--output', '-', // Output to stdout
      '--user-agent', user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      '--hls-use-mpegts', // Usar MPEGTS para HLS
      '--hls-prefer-native', // Usar descargador nativo de HLS
      '--retries', '10',
      '--fragment-retries', '10',
      '--live-from-start',
      '--no-part'
    ];

    // Agregar referer si existe
    if (referer) {
      ytdlpArgs.push('--referer', referer);
    }

    // Agregar headers adicionales
    ytdlpArgs.push(
      '--add-header', `User-Agent:${user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}`,
      '--add-header', 'Accept:application/vnd.apple.mpegurl,application/x-mpegurl,*/*',
      '--add-header', 'Accept-Language:en-US,en;q=0.9,es;q=0.8',
      '--add-header', 'Cache-Control:no-cache',
      '--add-header', 'Connection:keep-alive'
    );

    ytdlpArgs.push(source_m3u8);

    console.log(`🎯 Comando yt-dlp [${process_id}]:`, 'yt-dlp', ytdlpArgs.join(' '));

    // Configuración de ffmpeg para recibir el stream de yt-dlp
    const ffmpegArgs = [
      '-re', // Leer a velocidad nativa
      '-i', 'pipe:0', // Leer desde stdin (pipe de yt-dlp)
      '-c:v', 'copy', // Copiar video sin recodificar
      '-c:a', 'copy', // Copiar audio sin recodificar
      '-f', 'flv', // Formato FLV para RTMP
      '-flvflags', 'no_duration_filesize',
      '-avoid_negative_ts', 'make_zero',
      '-fflags', '+genpts',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '2',
      target_rtmp
    ];

    console.log(`🔧 Comando ffmpeg [${process_id}]:`, 'ffmpeg', ffmpegArgs.join(' '));

    // Iniciar yt-dlp
    const ytdlpProcess = spawn('yt-dlp', ytdlpArgs);
    
    // Iniciar ffmpeg y conectar con pipe
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

    // Conectar yt-dlp stdout con ffmpeg stdin
    ytdlpProcess.stdout.pipe(ffmpegProcess.stdin);

    // Guardar ambos procesos
    streamingProcesses.set(process_id, {
      ytdlp: ytdlpProcess,
      ffmpeg: ffmpegProcess
    });

    // Manejar salida de yt-dlp
    ytdlpProcess.stderr.on('data', (data) => {
      const output = data.toString();
      console.log(`📺 yt-dlp stderr [${process_id}]:`, output);
      
      if (output.includes('[download]') || output.includes('Downloading')) {
        const currentStatus = emissionStatuses.get(process_id);
        if (currentStatus === 'starting') {
          emissionStatuses.set(process_id, 'running');
          console.log(`✅ Stream yt-dlp [${process_id}] iniciado exitosamente`);
        }
      }
    });

    // Manejar salida de ffmpeg
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      console.log(`📺 ffmpeg stderr [${process_id}]:`, output);
      
      if (output.includes('frame=') || output.includes('fps=')) {
        const currentStatus = emissionStatuses.get(process_id);
        if (currentStatus === 'starting') {
          emissionStatuses.set(process_id, 'running');
          console.log(`✅ Pipeline ffmpeg [${process_id}] iniciado exitosamente`);
        }
      }
    });

    // Manejar errores y cierre de yt-dlp
    ytdlpProcess.on('error', (error) => {
      console.error(`❌ Error en yt-dlp [${process_id}]:`, error);
      emissionStatuses.set(process_id, 'error');
      ffmpegProcess.kill('SIGTERM');
      streamingProcesses.delete(process_id);
      reject(error);
    });

    ytdlpProcess.on('close', (code) => {
      console.log(`🔚 yt-dlp [${process_id}] terminó con código: ${code}`);
      if (code !== 0) {
        emissionStatuses.set(process_id, 'error');
        ffmpegProcess.kill('SIGTERM');
      }
    });

    // Manejar errores y cierre de ffmpeg
    ffmpegProcess.on('error', (error) => {
      console.error(`❌ Error en ffmpeg [${process_id}]:`, error);
      emissionStatuses.set(process_id, 'error');
      ytdlpProcess.kill('SIGTERM');
      streamingProcesses.delete(process_id);
      reject(error);
    });

    ffmpegProcess.on('close', (code) => {
      console.log(`🔚 ffmpeg [${process_id}] terminó con código: ${code}`);
      emissionStatuses.set(process_id, code === 0 ? 'idle' : 'error');
      ytdlpProcess.kill('SIGTERM');
      streamingProcesses.delete(process_id);
    });

    resolve({ ytdlpProcess, ffmpegProcess });
  });
}

// Endpoint para iniciar emisión
app.post('/api/emit', async (req, res) => {
  try {
    const { source_m3u8, target_rtmp, user_agent, referer, process_id = '0' } = req.body;

    // Validaciones
    if (!source_m3u8 || !target_rtmp) {
      return res.status(400).json({ 
        error: 'Faltan parámetros requeridos: source_m3u8 y target_rtmp' 
      });
    }

    // Si ya hay un proceso corriendo para este ID, detenerlo primero
    const existingProcess = streamingProcesses.get(process_id);
    if (existingProcess) {
      console.log(`🛑 Deteniendo procesos existentes para ID ${process_id}...`);
      if (existingProcess.ytdlp && !existingProcess.ytdlp.killed) {
        existingProcess.ytdlp.kill('SIGTERM');
      }
      if (existingProcess.ffmpeg && !existingProcess.ffmpeg.killed) {
        existingProcess.ffmpeg.kill('SIGTERM');
      }
      streamingProcesses.delete(process_id);
    }

    emissionStatuses.set(process_id, 'starting');
    console.log('🚀 Iniciando emisión robusta:', { source_m3u8, target_rtmp, user_agent, referer, process_id });

    // Iniciar stream robusto con yt-dlp + ffmpeg
    await startRobustStream(source_m3u8, target_rtmp, user_agent, referer, process_id);

    // Simular delay de inicio para permitir que los procesos se estabilicen
    setTimeout(() => {
      const currentStatus = emissionStatuses.get(process_id);
      const processData = streamingProcesses.get(process_id);
      if (currentStatus === 'starting' && processData) {
        emissionStatuses.set(process_id, 'running');
        console.log(`✅ Pipeline completo [${process_id}] está corriendo`);
      }
    }, 5000);

    res.json({ 
      success: true, 
      message: 'Emisión robusta iniciada correctamente',
      method: 'yt-dlp + ffmpeg pipeline',
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
    console.log(`🛑 Solicitada detención de emisión para proceso ${process_id}`);
    
    const processData = streamingProcesses.get(process_id);
    if (processData) {
      emissionStatuses.set(process_id, 'stopping');
      
      // Intentar terminar graciosamente ambos procesos
      if (processData.ytdlp && !processData.ytdlp.killed) {
        processData.ytdlp.kill('SIGTERM');
      }
      if (processData.ffmpeg && !processData.ffmpeg.killed) {
        processData.ffmpeg.kill('SIGTERM');
      }
      
      // Si no terminan en 5 segundos, forzar terminación
      setTimeout(() => {
        const currentProcessData = streamingProcesses.get(process_id);
        if (currentProcessData) {
          if (currentProcessData.ytdlp && !currentProcessData.ytdlp.killed) {
            console.log(`🔥 Forzando terminación de yt-dlp [${process_id}]...`);
            currentProcessData.ytdlp.kill('SIGKILL');
          }
          if (currentProcessData.ffmpeg && !currentProcessData.ffmpeg.killed) {
            console.log(`🔥 Forzando terminación de ffmpeg [${process_id}]...`);
            currentProcessData.ffmpeg.kill('SIGKILL');
          }
        }
      }, 5000);
      
      streamingProcesses.delete(process_id);
      emissionStatuses.set(process_id, 'idle');
      
      res.json({ 
        success: true, 
        message: `Emisión ${process_id} detenida correctamente` 
      });
    } else {
      emissionStatuses.set(process_id, 'idle');
      res.json({ 
        success: true, 
        message: `No hay emisión activa para proceso ${process_id}` 
      });
    }
    
  } catch (error) {
    console.error('❌ Error en /api/emit/stop:', error);
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
    const processData = streamingProcesses.get(process_id);
    const status = emissionStatuses.get(process_id) || 'idle';
    res.json({
      process_id,
      status,
      ytdlp_running: processData && processData.ytdlp && !processData.ytdlp.killed,
      ffmpeg_running: processData && processData.ffmpeg && !processData.ffmpeg.killed,
      pipeline_running: processData && 
        processData.ytdlp && !processData.ytdlp.killed &&
        processData.ffmpeg && !processData.ffmpeg.killed,
      timestamp: new Date().toISOString()
    });
  } else {
    // Estado de todos los procesos
    const allStatuses = {};
    for (let i = 0; i < 3; i++) {
      const id = i.toString();
      const processData = streamingProcesses.get(id);
      allStatuses[id] = {
        status: emissionStatuses.get(id) || 'idle',
        ytdlp_running: processData && processData.ytdlp && !processData.ytdlp.killed,
        ffmpeg_running: processData && processData.ffmpeg && !processData.ffmpeg.killed,
        pipeline_running: processData && 
          processData.ytdlp && !processData.ytdlp.killed &&
          processData.ffmpeg && !processData.ffmpeg.killed
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

// Endpoint para obtener recursos del sistema en tiempo real
app.get('/api/system-resources', async (req, res) => {
  try {
    const systemInfo = {
      timestamp: new Date().toISOString(),
      node: {
        pid: process.pid,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage()
      },
      system: {
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        totalMemory: os.totalmem(),
        freeMemory: os.freemem(),
        loadAverage: os.loadavg()
      },
      processes: {
        active_streaming: streamingProcesses.size,
        streaming_processes: []
      }
    };

    // Obtener información detallada de procesos de streaming
    for (const [processId, processData] of streamingProcesses) {
      const processInfo = {
        id: processId,
        status: emissionStatuses.get(processId) || 'unknown',
        ytdlp: null,
        ffmpeg: null
      };
      
      if (processData.ytdlp && !processData.ytdlp.killed) {
        processInfo.ytdlp = { pid: processData.ytdlp.pid };
      }
      
      if (processData.ffmpeg && !processData.ffmpeg.killed) {
        processInfo.ffmpeg = { pid: processData.ffmpeg.pid };
      }
      
      systemInfo.processes.streaming_processes.push(processInfo);
    }

    // Intentar obtener información adicional del sistema (Linux/Unix)
    if (os.platform() !== 'win32') {
      try {
        // CPU usage del sistema
        const cpuInfo = await execAsync("top -bn1 | grep 'Cpu(s)' | awk '{print $2}' | cut -d'%' -f1");
        systemInfo.system.cpuUsage = parseFloat(cpuInfo.stdout.trim()) || 0;

        // Memoria en uso
        const memInfo = await execAsync("free | grep Mem | awk '{printf \"%.1f\", ($3/$2) * 100.0}'");
        systemInfo.system.memoryUsage = parseFloat(memInfo.stdout.trim()) || 0;

        // Top procesos por CPU
        const topProcesses = await execAsync("ps aux --sort=-%cpu | head -6 | tail -5");
        systemInfo.processes.top_cpu = topProcesses.stdout.split('\n')
          .filter(line => line.trim())
          .map(line => {
            const parts = line.trim().split(/\s+/);
            return {
              user: parts[0],
              pid: parts[1],
              cpu: parseFloat(parts[2]) || 0,
              memory: parseFloat(parts[3]) || 0,
              command: parts.slice(10).join(' ').substring(0, 50)
            };
          });

        // Procesos ffmpeg y yt-dlp específicos
        const streamingPs = await execAsync("ps aux | grep -E '(ffmpeg|yt-dlp)' | grep -v grep || echo ''");
        systemInfo.processes.streaming_details = streamingPs.stdout.split('\n')
          .filter(line => line.trim() && (line.includes('ffmpeg') || line.includes('yt-dlp')))
          .map(line => {
            const parts = line.trim().split(/\s+/);
            return {
              pid: parts[1],
              cpu: parseFloat(parts[2]) || 0,
              memory: parseFloat(parts[3]) || 0,
              command: parts.slice(10).join(' ').substring(0, 100),
              type: line.includes('yt-dlp') ? 'yt-dlp' : 'ffmpeg'
            };
          });

      } catch (sysError) {
        console.log('⚠️ No se pudo obtener información detallada del sistema:', sysError.message);
        systemInfo.system.cpuUsage = 0;
        systemInfo.system.memoryUsage = (1 - os.freemem() / os.totalmem()) * 100;
        systemInfo.processes.top_cpu = [];
        systemInfo.processes.streaming_details = [];
      }
    } else {
      // Para Windows, información básica
      systemInfo.system.cpuUsage = 0;
      systemInfo.system.memoryUsage = (1 - os.freemem() / os.totalmem()) * 100;
      systemInfo.processes.top_cpu = [];
      systemInfo.processes.streaming_details = [];
    }

    res.json(systemInfo);
  } catch (error) {
    console.error('❌ Error obteniendo recursos del sistema:', error);
    res.status(500).json({ 
      error: 'Error obteniendo recursos del sistema',
      details: error.message 
    });
  }
});

// Servir archivos estáticos de React en producción
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

// Manejo de cierre limpio
process.on('SIGINT', () => {
  console.log('🔚 Cerrando servidor...');
  streamingProcesses.forEach((processData, processId) => {
    if (processData.ytdlp && !processData.ytdlp.killed) {
      console.log(`🛑 Deteniendo yt-dlp [${processId}]...`);
      processData.ytdlp.kill('SIGTERM');
    }
    if (processData.ffmpeg && !processData.ffmpeg.killed) {
      console.log(`🛑 Deteniendo ffmpeg [${processId}]...`);
      processData.ffmpeg.kill('SIGTERM');
    }
  });
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🔚 Recibida señal SIGTERM, cerrando servidor...');
  streamingProcesses.forEach((processData, processId) => {
    if (processData.ytdlp && !processData.ytdlp.killed) {
      console.log(`🛑 Deteniendo yt-dlp [${processId}]...`);
      processData.ytdlp.kill('SIGTERM');
    }
    if (processData.ffmpeg && !processData.ffmpeg.killed) {
      console.log(`🛑 Deteniendo ffmpeg [${processId}]...`);
      processData.ffmpeg.kill('SIGTERM');
    }
  });
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📡 Panel disponible en: http://localhost:${PORT}`);
  console.log(`🔧 Asegúrate de tener yt-dlp y FFmpeg instalados y accesibles en PATH`);
});

export default app;