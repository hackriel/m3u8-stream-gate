#!/usr/bin/env python3
"""
Mini-servicio HTTP de stats para Raspberry Pi 5.
Expone GET /stats con CPU, RAM, temperatura y load.
Sin dependencias externas (solo stdlib).

Instalación en el Pi5:
  sudo cp pi5-stats.py /usr/local/bin/pi5-stats.py
  sudo chmod +x /usr/local/bin/pi5-stats.py

  # Crear servicio systemd:
  sudo tee /etc/systemd/system/pi5-stats.service > /dev/null <<EOF
  [Unit]
  Description=Pi5 Stats HTTP endpoint
  After=network.target

  [Service]
  Type=simple
  ExecStart=/usr/bin/python3 /usr/local/bin/pi5-stats.py
  Restart=always
  RestartSec=5
  User=ariel

  [Install]
  WantedBy=multi-user.target
  EOF

  sudo systemctl daemon-reload
  sudo systemctl enable --now pi5-stats.service

  # Abrir puerto 8080 (si tenés firewall):
  sudo ufw allow 8080/tcp

Test:
  curl http://localhost:8080/stats
"""
import json
import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8080
START_TIME = time.time()


def read_cpu_times():
    """Lee /proc/stat → tupla (idle, total)."""
    with open('/proc/stat', 'r') as f:
        line = f.readline()
    parts = line.split()
    # cpu user nice system idle iowait irq softirq steal guest guest_nice
    nums = list(map(int, parts[1:]))
    idle = nums[3] + nums[4]  # idle + iowait
    total = sum(nums)
    return idle, total


_prev = read_cpu_times()


def get_cpu_pct():
    """Calcula %CPU comparando con la lectura anterior."""
    global _prev
    idle1, total1 = _prev
    idle2, total2 = read_cpu_times()
    _prev = (idle2, total2)
    didle = idle2 - idle1
    dtotal = total2 - total1
    if dtotal == 0:
        return 0.0
    return round(100.0 * (1.0 - didle / dtotal), 1)


def get_ram():
    """Lee /proc/meminfo → (used_mb, total_mb, pct)."""
    info = {}
    with open('/proc/meminfo', 'r') as f:
        for line in f:
            k, v = line.split(':', 1)
            info[k.strip()] = int(v.strip().split()[0])  # KB
    total_kb = info.get('MemTotal', 0)
    avail_kb = info.get('MemAvailable', info.get('MemFree', 0))
    used_kb = total_kb - avail_kb
    total_mb = total_kb // 1024
    used_mb = used_kb // 1024
    pct = round(100.0 * used_kb / total_kb, 1) if total_kb else 0.0
    return used_mb, total_mb, pct


def get_temp_c():
    """Lee temperatura del SoC (Pi5)."""
    paths = [
        '/sys/class/thermal/thermal_zone0/temp',
        '/sys/devices/virtual/thermal/thermal_zone0/temp',
    ]
    for p in paths:
        try:
            with open(p, 'r') as f:
                raw = int(f.read().strip())
            return round(raw / 1000.0, 1)
        except Exception:
            continue
    return None


def get_load_avg():
    try:
        return os.getloadavg()[0]
    except Exception:
        return None


def get_uptime_sec():
    try:
        with open('/proc/uptime', 'r') as f:
            return int(float(f.read().split()[0]))
    except Exception:
        return int(time.time() - START_TIME)


class StatsHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/stats':
            self.send_response(404)
            self.end_headers()
            return
        try:
            cpu = get_cpu_pct()
            used_mb, total_mb, ram_pct = get_ram()
            temp = get_temp_c()
            load1 = get_load_avg()
            uptime = get_uptime_sec()
            payload = {
                'cpu_pct': cpu,
                'ram_pct': ram_pct,
                'ram_used_mb': used_mb,
                'ram_total_mb': total_mb,
                'temp_c': temp,
                'load_avg_1': round(load1, 2) if load1 is not None else None,
                'uptime_sec': uptime,
                'ts': int(time.time()),
            }
            body = json.dumps(payload).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            err = json.dumps({'error': str(e)}).encode('utf-8')
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(err)

    def log_message(self, *args, **kwargs):
        # Silenciar logs HTTP
        pass


def main():
    server = HTTPServer(('0.0.0.0', PORT), StatsHandler)
    print(f'pi5-stats listening on :{PORT}/stats')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


if __name__ == '__main__':
    main()
