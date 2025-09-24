import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
    const { source_m3u8, target_rtmp, user_agent, process_id = '0', custom_quality = false, video_bitrate = '2000k', video_resolution = '1920x1080' } = req.body;

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
    console.log('🚀 Iniciando emisión:', { source_m3u8, target_rtmp, user_agent, process_id, custom_quality, video_bitrate, video_resolution });

    // Construir comando ffmpeg según configuración de calidad
    let ffmpegArgs;
    
    if (custom_quality) {
      // Comando con recodificación personalizada
      // Construir headers HTTP
      console.log(`🔧 Configurando headers para proceso ${process_id}:`);
      let headers = `User-Agent: ${user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}`;
      if (referer) {
        headers += `\r\nReferer: ${referer}`;
        console.log(`   Referer: ${referer}`);
      }
      if (origin) {
        headers += `\r\nOrigin: ${origin}`;
        console.log(`   Origin: ${origin}`);  
      }
      console.log(`   User-Agent: ${user_agent || 'default'}`);
      console.log(`📄 Headers completos: ${headers.replace(/\r\n/g, ' | ')}`);

      ffmpegArgs = [
        '-re', // Leer input a su velocidad nativa
        '-headers', headers,
        '-i', source_m3u8,
        '-c:v', 'libx264', // Recodificar video
        '-b:v', video_bitrate, // Bitrate personalizado
        '-s', video_resolution, // Resolución personalizada
        '-preset', 'fast', // Preset de codificación rápido
        '-c:a', 'aac', // Recodificar audio a AAC
        '-b:a', '128k', // Bitrate de audio
        '-f', 'flv',    // Formato de salida FLV para RTMP
        '-flvflags', 'no_duration_filesize',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        target_rtmp
      ];
    } else {
      // Comando SIN COMPRESIÓN - stream directo (modo original)
      // Construir headers HTTP
      console.log(`🔧 Configurando headers para proceso ${process_id} (sin compresión):`);
      let headers = `User-Agent: ${user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}`;
      if (referer) {
        headers += `\r\nReferer: ${referer}`;
        console.log(`   Referer: ${referer}`);
      }
      if (origin) {
        headers += `\r\nOrigin: ${origin}`;
        console.log(`   Origin: ${origin}`);
      }
      console.log(`   User-Agent: ${user_agent || 'default'}`);
      console.log(`📄 Headers completos: ${headers.replace(/\r\n/g, ' | ')}`);

      ffmpegArgs = [
        '-re', // Leer input a su velocidad nativa
        '-headers', headers,
        '-i', source_m3u8,
        '-c:v', 'copy', // Copiar video sin recodificar
        '-c:a', 'copy', // Copiar audio sin recodificar
        '-f', 'flv',    // Formato de salida FLV para RTMP
        '-flvflags', 'no_duration_filesize',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        target_rtmp
      ];
    }

    console.log(`🔧 Comando ffmpeg para proceso ${process_id}:`, 'ffmpeg', ffmpegArgs.join(' '));
    console.log(`🎛️ Modo de calidad: ${custom_quality ? 'Personalizada' : 'Original'}`);
    if (custom_quality) {
      console.log(`📹 Configuración: ${video_resolution} @ ${video_bitrate}`);
    }

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