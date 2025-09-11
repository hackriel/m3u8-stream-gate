#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Iniciando Plataforma de Emisión M3U8 → RTMP');
console.log('==================================================');

// Verificar que FFmpeg esté instalado
function checkFFmpeg() {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-version']);
    
    ffmpeg.on('error', (error) => {
      console.error('❌ FFmpeg no encontrado. Instala FFmpeg primero:');
      console.error('   Ubuntu/Debian: sudo apt update && sudo apt install ffmpeg');
      console.error('   CentOS/RHEL: sudo yum install ffmpeg');
      console.error('   macOS: brew install ffmpeg');
      reject(error);
    });
    
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log('✅ FFmpeg encontrado y funcionando');
        resolve();
      } else {
        reject(new Error('FFmpeg no funciona correctamente'));
      }
    });
  });
}

// Verificar Node.js version
function checkNodeVersion() {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0]);
  
  if (major < 18) {
    console.error(`❌ Node.js ${version} no soportado. Usa Node.js 18+ (recomendado: 20+)`);
    process.exit(1);
  }
  
  console.log(`✅ Node.js ${version} compatible`);
}

async function startServer() {
  try {
    // Verificaciones previas
    checkNodeVersion();
    await checkFFmpeg();
    
    console.log('🔧 Iniciando servidor backend...');
    
    // Iniciar servidor Express
    const server = spawn('node', ['server.js'], {
      cwd: __dirname,
      stdio: 'inherit'
    });
    
    server.on('error', (error) => {
      console.error('❌ Error iniciando servidor:', error);
      process.exit(1);
    });
    
    server.on('close', (code) => {
      console.log(`🔚 Servidor terminó con código: ${code}`);
      process.exit(code);
    });
    
    // Manejo de señales para cierre limpio
    process.on('SIGINT', () => {
      console.log('\n🛑 Cerrando aplicación...');
      server.kill('SIGTERM');
    });
    
    process.on('SIGTERM', () => {
      console.log('\n🛑 Recibida señal SIGTERM...');
      server.kill('SIGTERM');
    });
    
  } catch (error) {
    console.error('❌ Error en verificaciones:', error.message);
    process.exit(1);
  }
}

startServer();