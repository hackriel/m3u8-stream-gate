import React, { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, BarChart, Bar } from "recharts";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface SystemResource {
  timestamp: string;
  node: {
    pid: number;
    uptime: number;
    memory: {
      rss: number;
      heapTotal: number;
      heapUsed: number;
      external: number;
      arrayBuffers: number;
    };
    cpu: {
      user: number;
      system: number;
    };
  };
  system: {
    platform: string;
    arch: string;
    cpus: number;
    totalMemory: number;
    freeMemory: number;
    loadAverage: number[];
    cpuUsage?: number;
    memoryUsage?: number;
  };
  processes: {
    active_ffmpeg: number;
    ffmpeg_processes: Array<{
      id: string;
      pid: number;
      status: string;
    }>;
    top_cpu?: Array<{
      user: string;
      pid: string;
      cpu: number;
      memory: number;
      command: string;
    }>;
    ffmpeg_details?: Array<{
      pid: string;
      cpu: number;
      memory: number;
      command: string;
    }>;
  };
}

export default function SystemMonitor() {
  const [resources, setResources] = useState<SystemResource | null>(null);
  const [history, setHistory] = useState<Array<{
    time: string;
    cpu: number;
    memory: number;
    nodeMemory: number;
    ffmpegCount: number;
  }>>([]);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    let interval: NodeJS.Timeout;

    const fetchResources = async () => {
      try {
        const response = await fetch('/api/system-resources');
        if (response.ok) {
          const data: SystemResource = await response.json();
          setResources(data);

          // Agregar a historial
          setHistory(prev => [
            ...prev.slice(-29), // Mantener últimos 30 puntos
            {
              time: new Date(data.timestamp).toLocaleTimeString(),
              cpu: data.system.cpuUsage || 0,
              memory: data.system.memoryUsage || 0,
              nodeMemory: (data.node.memory.rss / 1024 / 1024), // MB
              ffmpegCount: data.processes.active_ffmpeg
            }
          ]);
        }
      } catch (error) {
        console.error('Error fetching system resources:', error);
      }
    };

    if (isVisible) {
      fetchResources(); // Fetch inicial
      interval = setInterval(fetchResources, 3000); // Cada 3 segundos
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isVisible]);

  const formatBytes = (bytes: number) => {
    const sizes = ['B', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
  };

  const getStatusColor = (cpu: number) => {
    if (cpu > 80) return "bg-destructive";
    if (cpu > 60) return "bg-warning";
    if (cpu > 40) return "bg-accent";
    return "bg-primary";
  };

  if (!isVisible) {
    return (
      <div className="fixed bottom-4 right-4 z-50">
        <button
          onClick={() => setIsVisible(true)}
          className="px-4 py-2 rounded-xl bg-secondary hover:bg-secondary/90 text-secondary-foreground shadow-lg transition-all duration-200"
        >
          📊 Monitor Sistema
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-2xl w-full max-w-7xl h-[90vh] overflow-y-auto border border-border shadow-2xl">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-semibold text-primary flex items-center gap-2">
              📊 Monitor de Recursos VPS
              {resources && (
                <Badge variant="outline" className="ml-2">
                  {resources.system.platform} - {resources.system.cpus} CPUs
                </Badge>
              )}
            </h2>
            <button
              onClick={() => setIsVisible(false)}
              className="px-4 py-2 rounded-lg bg-secondary hover:bg-secondary/90 text-secondary-foreground transition-all duration-200"
            >
              ✖️ Cerrar
            </button>
          </div>

          {resources && (
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
              {/* Métricas principales */}
              <Card className="p-4">
                <h3 className="text-lg font-medium mb-3 text-accent">🖥️ Sistema General</h3>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">CPU Total:</span>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex h-2 w-2 rounded-full ${getStatusColor(resources.system.cpuUsage || 0)}`} />
                      <span className="font-semibold">{(resources.system.cpuUsage || 0).toFixed(1)}%</span>
                    </div>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Memoria Total:</span>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex h-2 w-2 rounded-full ${getStatusColor(resources.system.memoryUsage || 0)}`} />
                      <span className="font-semibold">{(resources.system.memoryUsage || 0).toFixed(1)}%</span>
                    </div>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">RAM Libre:</span>
                    <span className="font-semibold">{formatBytes(resources.system.freeMemory)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Load Average:</span>
                    <span className="font-semibold">{resources.system.loadAverage[0].toFixed(2)}</span>
                  </div>
                </div>
              </Card>

              {/* Node.js */}
              <Card className="p-4">
                <h3 className="text-lg font-medium mb-3 text-accent">🟢 Node.js Process</h3>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">PID:</span>
                    <span className="font-semibold">{resources.node.pid}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Uptime:</span>
                    <span className="font-semibold">{Math.floor(resources.node.uptime / 3600)}h {Math.floor((resources.node.uptime % 3600) / 60)}m</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">RSS Memory:</span>
                    <span className="font-semibold">{formatBytes(resources.node.memory.rss)}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Heap Used:</span>
                    <span className="font-semibold">{formatBytes(resources.node.memory.heapUsed)}</span>
                  </div>
                </div>
              </Card>

              {/* FFmpeg Processes */}
              <Card className="p-4">
                <h3 className="text-lg font-medium mb-3 text-accent">🎬 FFmpeg Processes</h3>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Activos:</span>
                    <Badge variant={resources.processes.active_ffmpeg > 0 ? "default" : "secondary"}>
                      {resources.processes.active_ffmpeg}
                    </Badge>
                  </div>
                  {resources.processes.ffmpeg_processes.map((proc, index) => (
                    <div key={index} className="flex justify-between items-center text-xs">
                      <span className="text-muted-foreground">Proceso {proc.id}:</span>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">PID {proc.pid}</Badge>
                        <Badge variant={proc.status === 'running' ? 'default' : 'secondary'} className="text-xs">
                          {proc.status}
                        </Badge>
                      </div>
                    </div>
                  ))}
                  {resources.processes.ffmpeg_details && resources.processes.ffmpeg_details.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-border">
                      <div className="text-xs text-muted-foreground mb-1">Uso de recursos:</div>
                      {resources.processes.ffmpeg_details.map((proc, index) => (
                        <div key={index} className="flex justify-between items-center text-xs">
                          <span>PID {proc.pid}:</span>
                          <span>CPU {proc.cpu.toFixed(1)}% | RAM {proc.memory.toFixed(1)}%</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Card>

              {/* Gráfico de recursos en tiempo real */}
              <Card className="p-4 lg:col-span-2 xl:col-span-3">
                <h3 className="text-lg font-medium mb-3 text-accent">📈 Recursos en Tiempo Real</h3>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={history} margin={{ left: 10, right: 30, top: 10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                      <XAxis dataKey="time" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                      <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: "hsl(var(--card))", 
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "0.75rem",
                          color: "hsl(var(--foreground))"
                        }}
                      />
                      <Line 
                        type="monotone" 
                        dataKey="cpu" 
                        stroke="hsl(var(--destructive))" 
                        strokeWidth={2}
                        name="CPU Sistema %"
                        dot={false}
                      />
                      <Line 
                        type="monotone" 
                        dataKey="memory" 
                        stroke="hsl(var(--warning))" 
                        strokeWidth={2}
                        name="Memoria Sistema %"
                        dot={false}
                      />
                      <Line 
                        type="monotone" 
                        dataKey="nodeMemory" 
                        stroke="hsl(var(--primary))" 
                        strokeWidth={2}
                        name="Node.js RAM (MB)"
                        dot={false}
                      />
                      <Line 
                        type="monotone" 
                        dataKey="ffmpegCount" 
                        stroke="hsl(var(--accent))" 
                        strokeWidth={2}
                        name="FFmpeg Activos"
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </Card>

              {/* Top procesos por CPU */}
              {resources.processes.top_cpu && resources.processes.top_cpu.length > 0 && (
                <Card className="p-4 lg:col-span-2">
                  <h3 className="text-lg font-medium mb-3 text-accent">🔥 Top Procesos por CPU</h3>
                  <div className="space-y-2">
                    {resources.processes.top_cpu.map((proc, index) => (
                      <div key={index} className="flex justify-between items-center text-sm bg-muted/30 rounded-lg p-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-xs">PID {proc.pid}</Badge>
                          <span className="text-xs font-mono max-w-[200px] truncate">{proc.command}</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          <span className={`inline-flex h-2 w-2 rounded-full ${getStatusColor(proc.cpu)}`} />
                          <span>CPU {proc.cpu.toFixed(1)}%</span>
                          <span>RAM {proc.memory.toFixed(1)}%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Advertencias y recomendaciones */}
              <Card className="p-4">
                <h3 className="text-lg font-medium mb-3 text-accent">⚠️ Alertas</h3>
                <div className="space-y-2">
                  {resources.system.cpuUsage && resources.system.cpuUsage > 80 && (
                    <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-2 text-sm">
                      <strong>CPU Alta:</strong> {resources.system.cpuUsage.toFixed(1)}% - Considera optimizar procesos
                    </div>
                  )}
                  {resources.system.memoryUsage && resources.system.memoryUsage > 85 && (
                    <div className="bg-warning/10 border border-warning/20 rounded-lg p-2 text-sm">
                      <strong>Memoria Alta:</strong> {resources.system.memoryUsage.toFixed(1)}% - Revisa procesos ffmpeg
                    </div>
                  )}
                  {resources.processes.active_ffmpeg > 2 && (
                    <div className="bg-accent/10 border border-accent/20 rounded-lg p-2 text-sm">
                      <strong>Múltiples FFmpeg:</strong> {resources.processes.active_ffmpeg} procesos activos
                    </div>
                  )}
                  {resources.system.loadAverage[0] > resources.system.cpus && (
                    <div className="bg-warning/10 border border-warning/20 rounded-lg p-2 text-sm">
                      <strong>Load High:</strong> {resources.system.loadAverage[0].toFixed(2)} (CPUs: {resources.system.cpus})
                    </div>
                  )}
                </div>
              </Card>
            </div>
          )}

          {!resources && (
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
                <p className="text-muted-foreground">Cargando información del sistema...</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}