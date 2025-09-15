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

// Variables globales para manejo de múltiples procesos ffmpeg
const ffmpegProcesses = new Map(); // Map<processId, { process, status }>
const emissionStatuses = new Map(); // Map<processId, status>

// Middleware básico
app.use(cors({
  origin: '*',
  credentials: true
}));
app.use(express.json());
app.use(express.static(join(__dirname, 'dist')));

// Endpoint para iniciar emisión
app.post('/api/emit', (req, res) => {
  try {
    const { source_m3u8, target_rtmp, user_agent, referer, process_id = '0' } = req.body;

    // Validaciones
    if (!source_m3u8 || !target_rtmp) {
      return res.status(400).json({ 
        error: 'Faltan parámetros requeridos: source_m3u8 y target_rtmp' 
      });
    }

    // Si ya hay un proceso corriendo para este ID, detenerlo primero
    const existingProcess = ffmpegProcesses.get(process_id);
    if (existingProcess && existingProcess.process && !existingProcess.process.killed) {
      console.log(`🛑 Deteniendo proceso ffmpeg existente para ID ${process_id}...`);
      existingProcess.process.kill('SIGTERM');
      ffmpegProcesses.delete(process_id);
    }

    emissionStatuses.set(process_id, 'starting');
    console.log('🚀 Iniciando emisión:', { source_m3u8, target_rtmp, user_agent, referer, process_id });

    // Construir comando ffmpeg optimizado para M3U8 - stream directo sin compresión
    const ffmpegArgs = [
      '-re', // Leer input a su velocidad nativa
      '-user_agent', user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      '-multiple_requests', '1', // Permitir múltiples requests HTTP
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '2'
    ];

    // Configurar headers para M3U8 (crítico para algunos streams)
    const headers = [];
    if (referer) {
      headers.push(`Referer: ${referer}`);
    }
    headers.push(`User-Agent: ${user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}`);
    headers.push(`Accept: */*`);
    headers.push(`Accept-Language: en-US,en;q=0.9`);
    headers.push(`Connection: keep-alive`);
    
    if (headers.length > 0) {
      ffmpegArgs.push('-headers', headers.join('\r\n'));
    }

    ffmpegArgs.push(
      '-i', source_m3u8,
      '-c:v', 'copy', // Copiar video sin recodificar
      '-c:a', 'copy', // Copiar audio sin recodificar
      '-avoid_negative_ts', 'make_zero', // Evitar timestamps negativos
      '-fflags', '+genpts+discardcorrupt', // Generar PTS y descartar corrupto
      '-f', 'flv',    // Formato de salida FLV para RTMP
      '-flvflags', 'no_duration_filesize',
      '-timeout', '30000000', // 30 segundos timeout
      '-rw_timeout', '30000000', // Read/write timeout
      target_rtmp
    );

    console.log(`🔧 Comando ffmpeg para proceso ${process_id}:`, 'ffmpeg', ffmpegArgs.join(' '));

    // Ejecutar ffmpeg
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    ffmpegProcesses.set(process_id, { process: ffmpegProcess, status: 'starting' });

    // Manejar salida estándar
    ffmpegProcess.stdout.on('data', (data) => {
      console.log(`📺 FFmpeg stdout [${process_id}]:`, data.toString());
    });

    // Manejar errores
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      console.log(`📺 FFmpeg stderr [${process_id}]:`, output);
      
      // Detectar cuando ffmpeg está corriendo exitosamente
      if (output.includes('frame=') || output.includes('fps=')) {
        const currentStatus = emissionStatuses.get(process_id);
        if (currentStatus === 'starting') {
          emissionStatuses.set(process_id, 'running');
          console.log(`✅ Emisión ${process_id} iniciada exitosamente`);
        }
      }
    });

    // Manejar cierre del proceso
    ffmpegProcess.on('close', (code) => {
      console.log(`🔚 FFmpeg [${process_id}] terminó con código: ${code}`);
      emissionStatuses.set(process_id, code === 0 ? 'idle' : 'error');
      ffmpegProcesses.delete(process_id);
    });

    // Manejar error del proceso
    ffmpegProcess.on('error', (error) => {
      console.error(`❌ Error en FFmpeg [${process_id}]:`, error);
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
    console.log(`🛑 Solicitada detención de emisión para proceso ${process_id}`);
    
    const processData = ffmpegProcesses.get(process_id);
    if (processData && processData.process && !processData.process.killed) {
      emissionStatuses.set(process_id, 'stopping');
      
      // Intentar terminar graciosamente
      processData.process.kill('SIGTERM');
      
      // Si no termina en 5 segundos, forzar terminación
      setTimeout(() => {
        const currentProcessData = ffmpegProcesses.get(process_id);
        if (currentProcessData && currentProcessData.process && !currentProcessData.process.killed) {
          console.log(`🔥 Forzando terminación de ffmpeg [${process_id}]...`);
          currentProcessData.process.kill('SIGKILL');
        }
      }, 5000);
      
      ffmpegProcesses.delete(process_id);
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
    for (let i = 0; i < 3; i++) {
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
        active_ffmpeg: ffmpegProcesses.size,
        ffmpeg_processes: []
      }
    };

    // Obtener información detallada de procesos ffmpeg
    for (const [processId, processData] of ffmpegProcesses) {
      if (processData.process && !processData.process.killed) {
        systemInfo.processes.ffmpeg_processes.push({
          id: processId,
          pid: processData.process.pid,
          status: emissionStatuses.get(processId) || 'unknown'
        });
      }
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

        // Procesos ffmpeg específicos
        const ffmpegPs = await execAsync("ps aux | grep ffmpeg | grep -v grep || echo ''");
        systemInfo.processes.ffmpeg_details = ffmpegPs.stdout.split('\n')
          .filter(line => line.trim() && line.includes('ffmpeg'))
          .map(line => {
            const parts = line.trim().split(/\s+/);
            return {
              pid: parts[1],
              cpu: parseFloat(parts[2]) || 0,
              memory: parseFloat(parts[3]) || 0,
              command: parts.slice(10).join(' ').substring(0, 100)
            };
          });

      } catch (sysError) {
        console.log('⚠️ No se pudo obtener información detallada del sistema:', sysError.message);
        systemInfo.system.cpuUsage = 0;
        systemInfo.system.memoryUsage = (1 - os.freemem() / os.totalmem()) * 100;
        systemInfo.processes.top_cpu = [];
        systemInfo.processes.ffmpeg_details = [];
      }
    } else {
      // Para Windows, información básica
      systemInfo.system.cpuUsage = 0;
      systemInfo.system.memoryUsage = (1 - os.freemem() / os.totalmem()) * 100;
      systemInfo.processes.top_cpu = [];
      systemInfo.processes.ffmpeg_details = [];
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

// Manejo de cierre limpio
process.on('SIGINT', () => {
  console.log('🔚 Cerrando servidor...');
  ffmpegProcesses.forEach((processData, processId) => {
    if (processData.process && !processData.process.killed) {
      console.log(`🛑 Deteniendo ffmpeg [${processId}]...`);
      processData.process.kill('SIGTERM');
    }
  });
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🔚 Recibida señal SIGTERM, cerrando servidor...');
  ffmpegProcesses.forEach((processData, processId) => {
    if (processData.process && !processData.process.killed) {
      console.log(`🛑 Deteniendo ffmpeg [${processId}]...`);
      processData.process.kill('SIGTERM');
    }
  });
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📡 Panel disponible en: http://localhost:${PORT}`);
  console.log(`🔧 Asegúrate de tener FFmpeg instalado y accesible en PATH`);
});

export default app;