import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Variables globales para manejo de proceso ffmpeg
let ffmpegProcess = null;
let emissionStatus = 'idle'; // idle, starting, running, stopping, error

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
    const { source_m3u8, target_rtmp, user_agent, video_bitrate } = req.body;

    // Validaciones
    if (!source_m3u8 || !target_rtmp) {
      return res.status(400).json({ 
        error: 'Faltan parámetros requeridos: source_m3u8 y target_rtmp' 
      });
    }

    // Si ya hay un proceso corriendo, detenerlo primero
    if (ffmpegProcess && !ffmpegProcess.killed) {
      console.log('🛑 Deteniendo proceso ffmpeg existente...');
      ffmpegProcess.kill('SIGTERM');
      ffmpegProcess = null;
    }

    emissionStatus = 'starting';
    console.log('🚀 Iniciando emisión:', { source_m3u8, target_rtmp, user_agent, video_bitrate });

    // Configurar bitrate (default 1500k si no se especifica)
    const bitrateValue = video_bitrate || '1500';

    // Construir comando ffmpeg
    const ffmpegArgs = [
      '-re', // Leer input a su velocidad nativa
      '-user_agent', user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      '-i', source_m3u8,
      '-vf', 'scale=-2:720', // Escalar a 720p manteniendo aspect ratio
      '-c:v', 'libx264', // Recodificar video con libx264
      '-b:v', `${bitrateValue}k`, // Bitrate de video especificado
      '-maxrate', `${parseInt(bitrateValue) * 1.2}k`, // Maxrate 20% más alto
      '-bufsize', `${parseInt(bitrateValue) * 2}k`, // Buffer size 2x el bitrate
      '-preset', 'veryfast', // Preset rápido para streaming en vivo
      '-c:a', 'aac',  // Recodificar audio a AAC
      '-b:a', '128k', // Bitrate de audio
      '-f', 'flv',    // Formato de salida FLV para RTMP
      '-flvflags', 'no_duration_filesize',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      target_rtmp
    ];

    console.log('🔧 Comando ffmpeg:', 'ffmpeg', ffmpegArgs.join(' '));

    // Ejecutar ffmpeg
    ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

    // Manejar salida estándar
    ffmpegProcess.stdout.on('data', (data) => {
      console.log('📺 FFmpeg stdout:', data.toString());
    });

    // Manejar errores
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      console.log('📺 FFmpeg stderr:', output);
      
      // Detectar cuando ffmpeg está corriendo exitosamente
      if (output.includes('frame=') || output.includes('fps=')) {
        if (emissionStatus === 'starting') {
          emissionStatus = 'running';
          console.log('✅ Emisión iniciada exitosamente');
        }
      }
    });

    // Manejar cierre del proceso
    ffmpegProcess.on('close', (code) => {
      console.log(`🔚 FFmpeg terminó con código: ${code}`);
      emissionStatus = code === 0 ? 'idle' : 'error';
      ffmpegProcess = null;
    });

    // Manejar error del proceso
    ffmpegProcess.on('error', (error) => {
      console.error('❌ Error en FFmpeg:', error);
      emissionStatus = 'error';
      ffmpegProcess = null;
    });

    // Simular delay de inicio
    setTimeout(() => {
      if (emissionStatus === 'starting' && ffmpegProcess && !ffmpegProcess.killed) {
        emissionStatus = 'running';
      }
    }, 3000);

    res.json({ 
      success: true, 
      message: 'Emisión iniciada correctamente',
      status: 'starting'
    });

  } catch (error) {
    console.error('❌ Error en /api/emit:', error);
    emissionStatus = 'error';
    res.status(500).json({ 
      error: 'Error interno del servidor', 
      details: error.message 
    });
  }
});

// Endpoint para detener emisión
app.post('/api/emit/stop', (req, res) => {
  try {
    console.log('🛑 Solicitada detención de emisión');
    
    if (ffmpegProcess && !ffmpegProcess.killed) {
      emissionStatus = 'stopping';
      
      // Intentar terminar graciosamente
      ffmpegProcess.kill('SIGTERM');
      
      // Si no termina en 5 segundos, forzar terminación
      setTimeout(() => {
        if (ffmpegProcess && !ffmpegProcess.killed) {
          console.log('🔥 Forzando terminación de ffmpeg...');
          ffmpegProcess.kill('SIGKILL');
        }
      }, 5000);
      
      ffmpegProcess = null;
      emissionStatus = 'idle';
      
      res.json({ 
        success: true, 
        message: 'Emisión detenida correctamente' 
      });
    } else {
      emissionStatus = 'idle';
      res.json({ 
        success: true, 
        message: 'No hay emisión activa' 
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
  res.json({
    status: emissionStatus,
    process_running: ffmpegProcess && !ffmpegProcess.killed,
    timestamp: new Date().toISOString()
  });
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
  if (ffmpegProcess && !ffmpegProcess.killed) {
    console.log('🛑 Deteniendo ffmpeg...');
    ffmpegProcess.kill('SIGTERM');
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🔚 Recibida señal SIGTERM, cerrando servidor...');
  if (ffmpegProcess && !ffmpegProcess.killed) {
    console.log('🛑 Deteniendo ffmpeg...');
    ffmpegProcess.kill('SIGTERM');
  }
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📡 Panel disponible en: http://localhost:${PORT}`);
  console.log(`🔧 Asegúrate de tener FFmpeg instalado y accesible en PATH`);
});

export default app;