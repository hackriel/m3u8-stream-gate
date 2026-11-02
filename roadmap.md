# Roadmap

- [x] Aplicar compatibilidad específica Disney 8 RTMP tras cierres de escritura a los 4s: CFR nativo, GOP entero, sin B-frames y tiempos normalizados; 18 pruebas y envío RTMP local de 8s con audio/video decodificables, DTS monotónicos y GOP 2.002s aprobados. Recepción remota pendiente de despliegue y prueba del usuario; no se publicó sobre el destino activo.

- [x] Revisar bitrate visible: mide salida; corregir sesgo del muestreo usando duración de fragmentos completos. 15 pruebas y HLS real 2182 kbps aprobados; aplicar requiere actualizar VPS. RTMP Disney 8 conserva destino manual y protecciones; recepción sostenida sigue sin verificar.

- [x] Mostrar la URL extraída en Disney 8 TDMax y distinguir obtener de actualizar; comprobado con respuesta controlada, sin alterar emisiones.
- [x] Cambiar Disney 8 TDMax a extracción directa de FUTV, sin URL de player; pantalla verificada y tres pruebas aprobadas conservando destino RTMP.
- [x] Agregar TDMax a Disney 8; comprobar pantalla, selección persistente y 10 pruebas sin alterar emisiones activas.
- [x] Asignar explícitamente Disney 8 a la cuenta TDMax info en VPS y en la extracción alternativa; probar ambas asignaciones.
- [x] Confirmar extracción FUTV en Disney 8 con info: registro del usuario del 2 de noviembre confirma cuenta info, URL obtenida y entrada HLS abierta con video/audio.

- [x] Contrastar Disney 8 con los requisitos oficiales de YouTube y corregir incompatibilidades de envío RTMP/RTMPS.
- [x] Validar argumentos y salida audiovisual de YouTube: 10 pruebas, tres muestras FLV decodificables y acceso al campo Disney 8.
- [ ] Confirmar recepción y estabilidad prolongada en YouTube: requiere desplegar VPS y una emisión de prueba autorizada con clave introducida en el panel.

- [x] Actualizar Vida del canal: perfiles vigentes, conclusiones prudentes y recomendaciones de Laboratorio.
- [x] Ocultar FOX+ Alterno sin alterar emisiones existentes.
- [x] Diagnosticar logs Disney 8, corregir reconexión EOF Telecable y comprobar DNS/TCP del destino RTMP.
- [ ] Verificar Disney 8 sostenido con M3U real y Telecable: requiere despliegue VPS y fuente real; no publicar una prueba encima del destino del cliente.
- [x] Validar 18 pruebas y pantalla con recomendaciones de ejemplo; autonomía desactivada por defecto.

- [x] Corregir consulta de métricas de Canal 13, Canal 8 y Canal 2; verificación real tras despliegue pendiente.
- [x] Ampliar captura compartida del Laboratorio a 120 segundos acumulando segmentos nuevos.
- [x] Añadir diagnóstico de frames/errores y descargas protegidas de cada salida con almacenamiento limitado.
- [x] Verificar 13 pruebas, pantalla y descarga MP4 con muestra sintética; sin evaluación visual de fútbol real.

- [x] Añadir actualización integral del VPS con configuración segura y validaciones.
- [x] Añadir prueba backend de extracción real de un canal Telecable.
- [x] Verificar sintaxis y flujo completo.
- [x] Evitar que overrides antiguos reemplacen las credenciales Telecable nuevas.
- [x] Corregir la validación HTTP posterior al login.
- [x] Añadir tab Laboratorio con FUTV y FOX y comparaciones aisladas.
- [x] Guardar resultados y límites de seguridad sin cambiar emisiones.
- [x] Probar captura, comparación y estados de la pantalla con señal local de prueba.
- [ ] Ejecutar con FUTV/FOX reales: requiere actualizar el VPS con el nuevo módulo.
- [x] Incluir dos salidas deportivas experimentales y comparar las cuatro sobre la misma muestra local de prueba antes del despliegue.
- [x] Añadir y validar con muestra local prueba no HD de 1000 kbps sin reintroducir los perfiles SD/Intermedio retirados en producción.