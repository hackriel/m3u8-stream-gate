# 🚀 Plataforma de Emisión M3U8 → RTMP

## Instalación y Deployment

### Requisitos Previos
- ✅ Node.js v20+ (ya tienes)
- ✅ FFmpeg instalado (ya tienes)
- ✅ NVM instalado (ya tienes)

### Pasos de Instalación

1. **Copia los archivos a tu servidor:**
   ```bash
   # Subir todos los archivos del proyecto a tu directorio
   scp -r ./* usuario@tuservidor:/ruta/a/tu/proyecto/
   ```

2. **Instalar dependencias:**
   ```bash
   cd /ruta/a/tu/proyecto
   npm install
   ```

3. **Construir la aplicación:**
   ```bash
   npm run build
   ```

4. **Iniciar la aplicación:**
   ```bash
   npm start
   ```

### Configuración de Producción

#### Usando PM2 (Recomendado para producción)
```bash
# Instalar PM2 globalmente
npm install -g pm2

# Crear archivo de configuración PM2
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'emisor-m3u8',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    }
  }]
}
EOF

# Iniciar con PM2
pm2 start ecosystem.config.js

# Verificar estado
pm2 status

# Ver logs
pm2 logs emisor-m3u8

# Guardar configuración PM2
pm2 save
pm2 startup
```

#### Usando systemd (Alternativa)
```bash
# Crear servicio systemd
sudo tee /etc/systemd/system/emisor-m3u8.service << EOF
[Unit]
Description=Emisor M3U8 to RTMP
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
Environment=NODE_ENV=production
Environment=PORT=3001
ExecStart=$(which node) server.js
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF

# Habilitar y iniciar servicio
sudo systemctl daemon-reload
sudo systemctl enable emisor-m3u8
sudo systemctl start emisor-m3u8

# Verificar estado
sudo systemctl status emisor-m3u8
```

### Configuración de Nginx (Proxy Reverso)

```nginx
server {
    listen 80;
    server_name tu-dominio.com;
    
    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }
    
    # Opcional: servir archivos estáticos directamente
    location /static/ {
        alias /ruta/a/tu/proyecto/dist/;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

### Configuración con SSL (Certbot)
```bash
# Instalar certbot
sudo apt install certbot python3-certbot-nginx

# Obtener certificado SSL
sudo certbot --nginx -d tu-dominio.com

# Verificar renovación automática
sudo systemctl status certbot.timer
```

### Firewall (UFW)
```bash
# Permitir HTTP/HTTPS
sudo ufw allow 'Nginx Full'

# O si no usas Nginx
sudo ufw allow 3001
```

### Monitoreo y Logs

```bash
# Ver logs en tiempo real
pm2 logs emisor-m3u8 --lines 100

# O con systemd
sudo journalctl -f -u emisor-m3u8

# Verificar procesos FFmpeg activos
ps aux | grep ffmpeg

# Monitorear uso de recursos
htop
```

## 🔧 Configuración Avanzada

### Variables de Entorno
Crea un archivo `.env` (opcional):
```env
NODE_ENV=production
PORT=3001
FFMPEG_PATH=/usr/bin/ffmpeg
MAX_CONCURRENT_STREAMS=3
LOG_LEVEL=info
```

### Optimizaciones de FFmpeg
El servidor incluye parámetros optimizados para streaming:
- `-re`: Lectura a velocidad nativa
- `-c:v copy`: Sin recodificación de video
- `-c:a aac -b:a 128k`: Audio AAC optimizado
- `-reconnect 1`: Reconexión automática
- `-flvflags no_duration_filesize`: Optimizado para streaming

## 🚨 Solución de Problemas

### Error: "FFmpeg no encontrado"
```bash
# Verificar instalación
which ffmpeg
ffmpeg -version

# Reinstalar si es necesario
sudo apt update && sudo apt install ffmpeg -y
```

### Error: "Puerto 3001 en uso"
```bash
# Encontrar proceso usando el puerto
sudo lsof -i :3001
sudo netstat -tulpn | grep 3001

# Cambiar puerto en server.js o usar variable de entorno
export PORT=3002
```

### Problemas de permisos
```bash
# Dar permisos de ejecución
chmod +x start-server.js
chmod +x server.js

# Verificar permisos de directorio
ls -la
```

### Streaming no funciona
1. Verificar conectividad a origen M3U8
2. Verificar conectividad a destino RTMP
3. Revisar logs de FFmpeg
4. Probar comando FFmpeg manualmente

## 📊 URLs Importantes

- **Panel Principal:** `http://tu-servidor:3001`
- **Estado API:** `http://tu-servidor:3001/api/status`
- **Health Check:** `http://tu-servidor:3001/api/health`

## 🔒 Seguridad

- Usa HTTPS en producción
- Configura firewall apropiadamente
- Limita acceso a IPs conocidas si es necesario
- Monitorea logs regularmente
- Mantén FFmpeg actualizado

¡Tu plataforma está lista para funcionar! 🎉