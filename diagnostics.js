// ============================================================================
// Módulo de Diagnóstico de Streaming y Red (read-only)
// ----------------------------------------------------------------------------
// Todas las pruebas de este módulo son NO destructivas: solo leen estado del
// sistema (sysctl, ip, ethtool, ss, /proc) o ejecutan herramientas de medición
// (iperf3 cliente/servidor, mtr, ping). NUNCA modifica sysctl, firewall,
// nginx, ffmpeg ni configuración de red.
// ============================================================================
import express from 'express';
import { exec, spawn } from 'child_process';
import os from 'os';
import net from 'net';
import http from 'http';
import dgram from 'dgram';

const router = express.Router();

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const run = (cmd, timeout = 15000) =>
  new Promise((resolve) => {
    exec(cmd, { timeout, maxBuffer: 8 * 1024 * 1024, shell: '/bin/bash' }, (err, stdout, stderr) => {
      resolve({
        cmd,
        ok: !err,
        code: err?.code ?? 0,
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
        error: err ? (err.killed ? 'timeout' : err.message) : null,
      });
    });
  });

const has = async (bin) => (await run(`command -v ${bin} || true`, 4000)).stdout.trim() !== '';

const num = (v) => {
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// Sanitiza un host/IP para uso en shell (solo caracteres válidos de host)
const safeHost = (h) => {
  const s = String(h || '').trim();
  return /^[A-Za-z0-9._:-]{1,255}$/.test(s) ? s : null;
};
const safePort = (p) => {
  const n = parseInt(p, 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
};

const status = (value, warnAt, badAt) => {
  if (value >= badAt) return 'red';
  if (value >= warnAt) return 'yellow';
  return 'green';
};

const defaultIface = async () => {
  const r = await run(`ip -o route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | head -1`, 5000);
  return r.stdout.trim() || 'eth0';
};

// ---------------------------------------------------------------------------
// TEST 1 — Estado del servidor
// ---------------------------------------------------------------------------
router.get('/server', async (_req, res) => {
  const iface = await defaultIface();
  const [uptimeR, freeR, ipLinkR, ssR, netstatR, psR] = await Promise.all([
    run('uptime'),
    run('free -m'),
    run('ip -s link'),
    run('ss -s'),
    run('netstat -s 2>/dev/null | head -120'),
    run(`ps -eo pcpu,pmem,rss,comm,args --sort=-pcpu | head -20`),
  ]);

  const cores = os.cpus().length;
  const load = os.loadavg();
  const totalMem = os.totalmem() / 1048576;
  const freeMem = os.freemem() / 1048576;

  // Contadores de la interfaz principal
  const linkBlock = ipLinkR.stdout.split(/\n(?=\d+:\s)/).find((b) => b.startsWith(`${''}`) && b.includes(`: ${iface}:`)) || '';
  const lines = linkBlock.split('\n').map((l) => l.trim());
  const rxIdx = lines.findIndex((l) => l.startsWith('RX:'));
  const txIdx = lines.findIndex((l) => l.startsWith('TX:'));
  const parseCounters = (idx) => {
    if (idx < 0 || !lines[idx + 1]) return null;
    const p = lines[idx + 1].split(/\s+/).map(num);
    return { bytes: p[0], packets: p[1], errors: p[2], dropped: p[3], overrun: p[4], extra: p[5] };
  };
  const rx = parseCounters(rxIdx);
  const tx = parseCounters(txIdx);

  const topProcs = psR.stdout
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((l) => {
      const m = l.trim().match(/^([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) return null;
      return { cpu: num(m[1]), mem: num(m[2]), rssMB: Math.round(num(m[3]) / 1024), comm: m[4], args: m[5].slice(0, 140) };
    })
    .filter(Boolean);

  const swapLine = freeR.stdout.split('\n').find((l) => l.startsWith('Swap:')) || '';
  const sw = swapLine.split(/\s+/).map(num);

  const loadRatio = cores ? load[0] / cores : 0;
  const memPct = totalMem ? ((totalMem - freeMem) / totalMem) * 100 : 0;

  res.json({
    iface,
    cpu: { cores, loadAvg: load, loadRatio: Math.round(loadRatio * 100) / 100, status: status(loadRatio, 0.7, 1.0) },
    memory: {
      totalMB: Math.round(totalMem),
      freeMB: Math.round(freeMem),
      usedPercent: Math.round(memPct * 10) / 10,
      status: status(memPct, 80, 92),
    },
    swap: { totalMB: sw[1] || 0, usedMB: sw[2] || 0, status: (sw[2] || 0) > 256 ? 'yellow' : 'green' },
    interfaceCounters: { rx, tx },
    topProcesses: topProcs,
    raw: {
      uptime: uptimeR.stdout.trim(),
      free: freeR.stdout.trim(),
      ss: ssR.stdout.trim(),
      netstat: netstatR.stdout.trim(),
    },
  });
});

// ---------------------------------------------------------------------------
// TEST 2 — Interfaz de red (drops / errores / velocidad)
// ---------------------------------------------------------------------------
router.get('/nic', async (req, res) => {
  const iface = safeHost(req.query.iface) || (await defaultIface());
  const [linkR, ethR, statsR] = await Promise.all([
    run(`ip -s link show ${iface}`),
    run(`ethtool ${iface} 2>&1 || true`),
    run(`ethtool -S ${iface} 2>&1 || true`),
  ]);

  const l = linkR.stdout.split('\n').map((x) => x.trim());
  const grab = (label) => {
    const i = l.findIndex((x) => x.startsWith(label));
    if (i < 0 || !l[i + 1]) return null;
    const p = l[i + 1].split(/\s+/).map(num);
    return { bytes: p[0], packets: p[1], errors: p[2], dropped: p[3], overrun: p[4], mcast_or_carrier: p[5] };
  };
  const rx = grab('RX:');
  const tx = grab('TX:');

  const interesting = {};
  statsR.stdout.split('\n').forEach((line) => {
    const m = line.trim().match(/^([a-z0-9_]+):\s+(\d+)$/i);
    if (!m) return;
    const key = m[1].toLowerCase();
    if (/(drop|error|miss|overrun|carrier|discard|no_buffer|fifo|nobuf)/.test(key)) {
      const v = parseInt(m[2], 10);
      if (v > 0) interesting[m[1]] = v;
    }
  });

  const speedM = ethR.stdout.match(/Speed:\s+(\d+)Mb\/s/);
  const duplexM = ethR.stdout.match(/Duplex:\s+(\w+)/);

  const rxDropRatio = rx && rx.packets ? (rx.dropped / rx.packets) * 100 : 0;
  const txDropRatio = tx && tx.packets ? (tx.dropped / tx.packets) * 100 : 0;
  const anyError = (rx?.errors || 0) + (tx?.errors || 0);

  let nicStatus = 'green';
  if (rxDropRatio > 0.01 || txDropRatio > 0.01 || anyError > 0) nicStatus = 'yellow';
  if (rxDropRatio > 0.1 || txDropRatio > 0.1 || anyError > 100) nicStatus = 'red';

  res.json({
    iface,
    speedMbps: speedM ? parseInt(speedM[1], 10) : null,
    duplex: duplexM ? duplexM[1] : null,
    rx,
    tx,
    rxDropPercent: Math.round(rxDropRatio * 1000) / 1000,
    txDropPercent: Math.round(txDropRatio * 1000) / 1000,
    driverCounters: interesting,
    status: nicStatus,
    raw: { ethtool: ethR.stdout.trim().slice(0, 4000), link: linkR.stdout.trim() },
  });
});

// ---------------------------------------------------------------------------
// TEST 3 — Buffers TCP/UDP del kernel (solo lectura + recomendación)
// ---------------------------------------------------------------------------
const SYSCTL_KEYS = [
  'net.core.rmem_max',
  'net.core.wmem_max',
  'net.core.rmem_default',
  'net.core.wmem_default',
  'net.core.netdev_max_backlog',
  'net.core.somaxconn',
  'net.ipv4.udp_mem',
  'net.ipv4.udp_rmem_min',
  'net.ipv4.udp_wmem_min',
  'net.ipv4.tcp_rmem',
  'net.ipv4.tcp_wmem',
  'net.ipv4.tcp_congestion_control',
  'net.ipv4.tcp_mtu_probing',
  'net.netfilter.nf_conntrack_max',
  'net.netfilter.nf_conntrack_count',
];

router.get('/sysctl', async (_req, res) => {
  const out = {};
  await Promise.all(
    SYSCTL_KEYS.map(async (k) => {
      const r = await run(`sysctl -n ${k} 2>/dev/null || true`, 4000);
      out[k] = r.stdout.trim() || null;
    })
  );

  const rmemMax = num(out['net.core.rmem_max']);
  const wmemMax = num(out['net.core.wmem_max']);
  const backlog = num(out['net.core.netdev_max_backlog']);

  const findings = [];
  // SRT recomienda al menos ~ 8-32 MB de buffer de socket para alto bitrate + latency alta
  if (rmemMax < 8 * 1024 * 1024)
    findings.push({
      level: rmemMax < 1024 * 1024 ? 'red' : 'yellow',
      key: 'net.core.rmem_max',
      value: rmemMax,
      msg: `rmem_max=${rmemMax} B. SRT con latency 2-4s a 4-8 Mbps necesita buffers grandes de recepción.`,
      suggestion: 'sysctl -w net.core.rmem_max=33554432   (aplicar manualmente si decidís cambiarlo)',
    });
  if (wmemMax < 8 * 1024 * 1024)
    findings.push({
      level: wmemMax < 1024 * 1024 ? 'red' : 'yellow',
      key: 'net.core.wmem_max',
      value: wmemMax,
      msg: `wmem_max=${wmemMax} B. Limita el buffer de envío (relevante si el VPS reenvía SRT/RTMP).`,
      suggestion: 'sysctl -w net.core.wmem_max=33554432',
    });
  if (backlog && backlog < 2000)
    findings.push({
      level: 'yellow',
      key: 'net.core.netdev_max_backlog',
      value: backlog,
      msg: `netdev_max_backlog=${backlog}. Con ráfagas UDP puede descartar paquetes antes del socket.`,
      suggestion: 'sysctl -w net.core.netdev_max_backlog=5000',
    });

  const ctMax = num(out['net.netfilter.nf_conntrack_max']);
  const ctCount = num(out['net.netfilter.nf_conntrack_count']);
  if (ctMax && ctCount / ctMax > 0.8)
    findings.push({
      level: 'red',
      key: 'nf_conntrack',
      value: `${ctCount}/${ctMax}`,
      msg: 'Tabla conntrack casi llena: se descartan conexiones/paquetes nuevos.',
      suggestion: 'Aumentar nf_conntrack_max o excluir el puerto SRT de conntrack (NOTRACK).',
    });

  const limits = await run('ulimit -n; cat /proc/sys/fs/file-nr 2>/dev/null', 4000);

  res.json({
    values: out,
    findings,
    status: findings.some((f) => f.level === 'red') ? 'red' : findings.length ? 'yellow' : 'green',
    limitsRaw: limits.stdout.trim(),
    note: 'Solo diagnóstico. No se modificó ningún valor del kernel.',
  });
});

// ---------------------------------------------------------------------------
// TEST 4 — iperf3 (servidor y cliente)
// ---------------------------------------------------------------------------
let iperfServer = null; // { proc, port, startedAt }

router.get('/iperf/status', async (_req, res) => {
  res.json({
    installed: await has('iperf3'),
    running: !!iperfServer && !iperfServer.proc.killed,
    port: iperfServer?.port || null,
    startedAt: iperfServer?.startedAt || null,
    publicHint: 'Desde tu PC: iperf3 -c <IP_VPS> -p <puerto>  /  UDP: iperf3 -c <IP_VPS> -p <puerto> -u -b 6M',
  });
});

router.post('/iperf/server', async (req, res) => {
  const action = String(req.body?.action || 'start');
  const port = safePort(req.body?.port) || 5201;

  if (action === 'stop') {
    if (iperfServer) {
      try { iperfServer.proc.kill('SIGTERM'); } catch (_) {}
      iperfServer = null;
    }
    return res.json({ running: false });
  }

  if (!(await has('iperf3'))) return res.status(400).json({ error: 'iperf3 no está instalado en el VPS (apt install iperf3)' });
  if (iperfServer && !iperfServer.proc.killed) return res.json({ running: true, port: iperfServer.port, already: true });

  const proc = spawn('iperf3', ['-s', '-p', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  iperfServer = { proc, port, startedAt: Date.now(), log: [] };
  proc.stdout.on('data', (d) => { iperfServer?.log.push(d.toString()); if (iperfServer?.log.length > 200) iperfServer.log.shift(); });
  proc.stderr.on('data', (d) => { iperfServer?.log.push(d.toString()); if (iperfServer?.log.length > 200) iperfServer.log.shift(); });
  proc.on('exit', () => { if (iperfServer?.proc === proc) iperfServer = null; });

  res.json({ running: true, port, note: 'Servidor iperf3 escuchando. Recordá abrir el puerto TCP+UDP en el firewall manualmente si hace falta.' });
});

router.get('/iperf/server-log', (_req, res) => {
  res.json({ log: (iperfServer?.log || []).join('') });
});

// Corre iperf3 como CLIENTE desde el VPS hacia un host (p. ej. tu PC con iperf3 -s)
const runIperfClient = async ({ host, port = 5201, udp = false, bitrateMbps = 0, seconds = 10, reverse = false }) => {
  const h = safeHost(host);
  if (!h) throw new Error('host inválido');
  const p = safePort(port) || 5201;
  const args = ['-c', h, '-p', String(p), '-t', String(Math.min(Math.max(parseInt(seconds, 10) || 10, 3), 60)), '-J'];
  if (udp) args.push('-u', '-b', `${Math.max(0.1, parseFloat(bitrateMbps) || 1)}M`);
  if (reverse) args.push('-R');
  const r = await run(`iperf3 ${args.join(' ')}`, (parseInt(seconds, 10) || 10) * 1000 + 20000);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch (_) {}
  if (!json) return { ok: false, error: r.stderr.trim() || r.error || 'sin salida JSON', raw: r.stdout.slice(0, 2000) };
  const end = json.end || {};
  const sum = udp ? end.sum || end.sum_received || {} : end.sum_received || {};
  const sent = end.sum_sent || {};
  return {
    ok: true,
    protocol: udp ? 'UDP' : 'TCP',
    targetMbps: udp ? parseFloat(bitrateMbps) : null,
    sentMbps: sent.bits_per_second ? Math.round((sent.bits_per_second / 1e6) * 100) / 100 : null,
    receivedMbps: sum.bits_per_second ? Math.round((sum.bits_per_second / 1e6) * 100) / 100 : null,
    lostPercent: sum.lost_percent != null ? Math.round(sum.lost_percent * 100) / 100 : null,
    lostPackets: sum.lost_packets ?? null,
    totalPackets: sum.packets ?? null,
    jitterMs: sum.jitter_ms != null ? Math.round(sum.jitter_ms * 100) / 100 : null,
    retransmits: sent.retransmits ?? null,
    seconds,
  };
};

router.post('/iperf/run', async (req, res) => {
  if (!(await has('iperf3'))) return res.status(400).json({ error: 'iperf3 no instalado en el VPS' });
  try {
    const out = await runIperfClient(req.body || {});
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// PRUEBA PRINCIPAL — Stress Test de Streaming (escalera de bitrates)
// ---------------------------------------------------------------------------
const stressState = { running: false, startedAt: null, target: null, steps: [], done: false, error: null, verdict: null };

router.get('/stress/state', (_req, res) => res.json(stressState));

router.post('/stress/start', async (req, res) => {
  if (stressState.running) return res.status(409).json({ error: 'Ya hay un stress test en curso' });
  const host = safeHost(req.body?.host);
  if (!host) return res.status(400).json({ error: 'host inválido (debe ser la IP/host que corre iperf3 -s)' });
  if (!(await has('iperf3'))) return res.status(400).json({ error: 'iperf3 no instalado en el VPS' });

  const port = safePort(req.body?.port) || 5201;
  const seconds = Math.min(Math.max(parseInt(req.body?.seconds, 10) || 10, 5), 30);
  const ladder = Array.isArray(req.body?.ladder) && req.body.ladder.length
    ? req.body.ladder.map((n) => parseFloat(n)).filter((n) => n > 0 && n <= 100)
    : [1, 2, 2.5, 3, 4, 5, 6, 8, 10];
  // reverse=true => el tráfico va DESDE el VPS HACIA tu red (simula download).
  // reverse=false => el tráfico va DESDE tu red HACIA el VPS (simula el envío del encoder).
  const reverse = !!req.body?.reverse;

  Object.assign(stressState, { running: true, startedAt: Date.now(), target: { host, port, seconds, reverse }, steps: [], done: false, error: null, verdict: null });
  res.json({ started: true, ladder });

  (async () => {
    try {
      const tcp = await runIperfClient({ host, port, udp: false, seconds, reverse });
      stressState.steps.push({ label: 'TCP baseline', ...tcp });
      for (const mbps of ladder) {
        if (!stressState.running) break;
        const r = await runIperfClient({ host, port, udp: true, bitrateMbps: mbps, seconds, reverse });
        stressState.steps.push({ label: `UDP ${mbps} Mbps`, ...r });
        await new Promise((x) => setTimeout(x, 1500));
      }
      // Punto de degradación: primer escalón UDP con pérdida > 1% o jitter > 20 ms
      const udpSteps = stressState.steps.filter((s) => s.protocol === 'UDP' && s.ok);
      const bad = udpSteps.find((s) => (s.lostPercent ?? 0) > 1 || (s.jitterMs ?? 0) > 20);
      const lastGood = [...udpSteps].reverse().find((s) => (s.lostPercent ?? 0) <= 1 && (s.jitterMs ?? 0) <= 20);
      stressState.verdict = {
        stableMbps: lastGood?.targetMbps ?? null,
        degradesAtMbps: bad?.targetMbps ?? null,
        tcpMbps: tcp.ok ? tcp.receivedMbps ?? tcp.sentMbps : null,
        tcpRetransmits: tcp.retransmits ?? null,
      };
    } catch (e) {
      stressState.error = e.message;
    } finally {
      stressState.running = false;
      stressState.done = true;
    }
  })();
});

router.post('/stress/stop', (_req, res) => {
  stressState.running = false;
  res.json({ stopped: true });
});

// ---------------------------------------------------------------------------
// TEST 5 — Ruta de Internet (MTR) + comparación con YouTube
// ---------------------------------------------------------------------------
const parseMtr = (raw) => {
  // Formato de `mtr --report --json` si está disponible; si no, texto.
  try {
    const j = JSON.parse(raw);
    const hubs = j?.report?.hubs || [];
    return hubs.map((h) => ({
      hop: h.count,
      host: h.host,
      lossPercent: num(h['Loss%']),
      avgMs: num(h.Avg),
      bestMs: num(h.Best),
      worstMs: num(h.Wrst),
      jitterMs: num(h.StDev),
      asn: h.ASN || null,
    }));
  } catch (_) {
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\d+\.\|--/.test(l))
      .map((l) => {
        const parts = l.replace('|--', '').split(/\s+/).filter(Boolean);
        const hop = parseInt(parts[0], 10);
        const asnIdx = parts.findIndex((p) => /^AS\d+/.test(p));
        const host = asnIdx >= 0 ? parts[asnIdx + 1] : parts[1];
        const nums = parts.slice(-7).map(num);
        return {
          hop,
          asn: asnIdx >= 0 ? parts[asnIdx] : null,
          host,
          lossPercent: nums[0],
          avgMs: nums[3],
          bestMs: nums[4],
          worstMs: nums[5],
          jitterMs: nums[6],
        };
      });
  }
};

const mtrTo = async (host, { udp = false, count = 50, port = null } = {}) => {
  const h = safeHost(host);
  if (!h) throw new Error('host inválido');
  const jsonSupported = (await run('mtr --help 2>&1 | grep -c -- --json || true', 5000)).stdout.trim() !== '0';
  const flags = ['-rwzc', String(Math.min(Math.max(count, 10), 200))];
  if (udp) flags.push('-u');
  if (port) flags.push('-P', String(safePort(port) || 443));
  if (jsonSupported) flags.push('--json');
  const r = await run(`mtr ${flags.join(' ')} ${h}`, count * 400 + 40000);
  const hops = parseMtr(r.stdout);
  const dest = hops[hops.length - 1] || null;
  return { host: h, udp, port: port || null, hops, destination: dest, raw: r.stdout.slice(0, 8000), error: hops.length ? null : r.stderr.trim() || r.error };
};

router.post('/mtr', async (req, res) => {
  if (!(await has('mtr'))) return res.status(400).json({ error: 'mtr no instalado en el VPS (apt install mtr-tiny)' });
  try {
    res.json(await mtrTo(req.body?.host, { udp: !!req.body?.udp, count: parseInt(req.body?.count, 10) || 50, port: req.body?.port }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Comparación de rutas: tu IP/red vs ingest de YouTube, medida desde el VPS
router.post('/route-compare', async (req, res) => {
  if (!(await has('mtr'))) return res.status(400).json({ error: 'mtr no instalado (apt install mtr-tiny)' });
  const clientHost = safeHost(req.body?.clientHost || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip?.replace('::ffff:', ''));
  const youtubeHost = safeHost(req.body?.youtubeHost) || 'a.rtmp.youtube.com';
  const count = parseInt(req.body?.count, 10) || 50;

  const [toClient, toYoutube] = await Promise.all([
    clientHost ? mtrTo(clientHost, { count }).catch((e) => ({ error: e.message })) : Promise.resolve({ error: 'sin IP de cliente' }),
    mtrTo(youtubeHost, { count }).catch((e) => ({ error: e.message })),
  ]);

  const summarize = (m) =>
    m?.destination
      ? {
          host: m.host,
          hops: m.hops.length,
          lossPercent: m.destination.lossPercent,
          avgMs: m.destination.avgMs,
          jitterMs: m.destination.jitterMs,
          asns: [...new Set(m.hops.map((h) => h.asn).filter(Boolean))],
        }
      : { host: m?.host || null, error: m?.error || 'sin datos' };

  res.json({
    clientPath: summarize(toClient),
    youtubePath: summarize(toYoutube),
    detail: { toClient, toYoutube },
    note: 'Comparar saltos, ASNs intermedios, jitter y pérdida en el DESTINO. Pérdida intermedia sin pérdida final suele ser rate-limit ICMP, no un problema real.',
  });
});

// ---------------------------------------------------------------------------
// TEST 6 — MTU / fragmentación
// ---------------------------------------------------------------------------
router.post('/mtu', async (req, res) => {
  const host = safeHost(req.body?.host);
  if (!host) return res.status(400).json({ error: 'host inválido' });

  // Búsqueda binaria del payload máximo sin fragmentar (DF activado)
  let lo = 1200;
  let hi = 1500;
  const tryPayload = async (payload) => {
    const r = await run(`ping -M do -c 1 -W 2 -s ${payload - 28} ${host} 2>&1 || true`, 8000);
    return /(\d+) bytes from/.test(r.stdout) && !/Frag needed|too long|100% packet loss/i.test(r.stdout);
  };
  if (!(await tryPayload(lo))) {
    return res.json({ host, mtu: null, status: 'red', message: `No hay respuesta ICMP ni a ${lo} bytes (el destino puede bloquear ICMP; probá contra la IP del VPS/tu router).` });
  }
  let best = lo;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    // eslint-disable-next-line no-await-in-loop
    if (await tryPayload(mid)) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  const localMtu = (await run(`ip link show ${await defaultIface()} | grep -o 'mtu [0-9]*' | awk '{print $2}'`, 4000)).stdout.trim();

  res.json({
    host,
    mtu: best,
    localMtu: parseInt(localMtu, 10) || null,
    status: best >= 1492 ? 'green' : best >= 1400 ? 'yellow' : 'red',
    srtPayloadRecommendation: Math.max(1000, best - 44),
    message:
      best >= 1500
        ? '🟢 Sin fragmentación hasta 1500 bytes.'
        : `🟡/🔴 MTU efectivo ${best}. Para SRT configurá el encoder con MTU ${Math.min(best, 1360)} (típico 1316 con PPPoE/VPN) para evitar fragmentación.`,
  });
});

// ---------------------------------------------------------------------------
// TEST 7 — Puertos (TCP listen + UDP bind + alcanzabilidad)
// ---------------------------------------------------------------------------
const DEFAULT_SRT_PORTS = [9001, 9002, 10000, 20000, 5000, 443];
const DEFAULT_RTMP_PORTS = [1935, 443];

const tcpProbe = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => resolve({ bindable: false, reason: e.code }));
    srv.listen(port, '0.0.0.0', () => srv.close(() => resolve({ bindable: true })));
  });

const udpProbe = (port) =>
  new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', (e) => resolve({ bindable: false, reason: e.code }));
    s.bind(port, '0.0.0.0', () => s.close(() => resolve({ bindable: true })));
  });

router.get('/ports', async (req, res) => {
  const srtPorts = (String(req.query.srt || '').split(',').map(safePort).filter(Boolean)) ;
  const rtmpPorts = (String(req.query.rtmp || '').split(',').map(safePort).filter(Boolean));
  const srt = srtPorts.length ? srtPorts : DEFAULT_SRT_PORTS;
  const rtmp = rtmpPorts.length ? rtmpPorts : DEFAULT_RTMP_PORTS;

  const [listenR, ufwR] = await Promise.all([run('ss -lntup 2>/dev/null'), run('ufw status verbose 2>/dev/null || iptables -S 2>/dev/null | head -40 || true')]);

  const inUse = (port, proto) =>
    listenR.stdout.split('\n').some((l) => l.startsWith(proto) && new RegExp(`[:.]${port}\\s`).test(l));

  const check = async (list, proto) =>
    Promise.all(
      list.map(async (p) => {
        const used = inUse(p, proto === 'udp' ? 'udp' : 'tcp');
        const probe = used ? { bindable: false, reason: 'EN_USO_POR_SERVICIO' } : await (proto === 'udp' ? udpProbe(p) : tcpProbe(p));
        const fwLine = ufwR.stdout.split('\n').find((l) => new RegExp(`\\b${p}\\b`).test(l)) || null;
        return {
          port: p,
          listening: used,
          bindable: probe.bindable,
          reason: probe.reason || null,
          firewall: fwLine ? fwLine.trim() : 'sin regla explícita encontrada',
          status: used ? 'green' : probe.bindable ? 'yellow' : 'red',
        };
      })
    );

  res.json({
    srt: await check(srt, 'udp'),
    rtmp: await check(rtmp, 'tcp'),
    firewallRaw: ufwR.stdout.trim().slice(0, 4000),
    listenRaw: listenR.stdout.trim().slice(0, 6000),
    note: 'listening = hay un servicio escuchando; bindable = puerto libre (no probado desde afuera). Para probar desde tu red usá el stress test / iperf3 en ese puerto.',
  });
});

// ---------------------------------------------------------------------------
// TEST 10 — Procesos FFmpeg
// ---------------------------------------------------------------------------
router.get('/ffmpeg', async (_req, res) => {
  const r = await run(`ps -eo pid,pcpu,pmem,rss,etimes,args --sort=-pcpu | grep -i '[f]fmpeg' | head -40`);
  const procs = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const m = l.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) return null;
      const args = m[6];
      const outMatch = args.match(/(rtmp:\/\/\S+|srt:\/\/\S+|\/live\/\S+)/g) || [];
      const inMatch = args.match(/-i\s+(\S+)/);
      const bitrate = args.match(/-b:v\s+(\S+)/);
      return {
        pid: parseInt(m[1], 10),
        cpu: num(m[2]),
        memPercent: num(m[3]),
        rssMB: Math.round(num(m[4]) / 1024),
        uptimeSec: parseInt(m[5], 10),
        input: inMatch ? inMatch[1] : null,
        outputs: outMatch.slice(-2),
        videoBitrate: bitrate ? bitrate[1] : null,
      };
    })
    .filter(Boolean);

  const cores = os.cpus().length;
  const totalCpu = procs.reduce((a, p) => a + p.cpu, 0);
  res.json({
    count: procs.length,
    cores,
    totalCpuPercent: Math.round(totalCpu * 10) / 10,
    cpuOfMachinePercent: Math.round((totalCpu / (cores * 100)) * 1000) / 10,
    status: totalCpu / (cores * 100) > 0.85 ? 'red' : totalCpu / (cores * 100) > 0.6 ? 'yellow' : 'green',
    processes: procs,
    note: 'FPS/DUP/DROP en vivo por canal están en el tab UPTIME (/api/status).',
  });
});

// ---------------------------------------------------------------------------
// TEST 11 — Sockets
// ---------------------------------------------------------------------------
router.get('/sockets', async (_req, res) => {
  const [sumR, tcpR, udpR, snmpR] = await Promise.all([
    run('ss -s'),
    run('ss -tin 2>/dev/null | head -120'),
    run('ss -uanp 2>/dev/null | head -80'),
    run('netstat -su 2>/dev/null; netstat -st 2>/dev/null | head -60'),
  ]);

  const retrans = [...tcpR.stdout.matchAll(/retrans:(\d+)\/(\d+)/g)].map((m) => ({ current: +m[1], total: +m[2] }));
  const totalRetrans = retrans.reduce((a, r) => a + r.total, 0);

  const udpQueues = udpR.stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 5)
    .map((p) => ({ recvQ: num(p[1]), sendQ: num(p[2]), local: p[3], peer: p[4], proc: p.slice(5).join(' ').slice(0, 80) }))
    .filter((x) => x.recvQ > 0 || x.sendQ > 0);

  const rcvErr = (snmpR.stdout.match(/(\d+)\s+packet receive errors/) || [])[1];
  const rcvBufErr = (snmpR.stdout.match(/RcvbufErrors:\s+(\d+)/) || [])[1];
  const sndBufErr = (snmpR.stdout.match(/SndbufErrors:\s+(\d+)/) || [])[1];

  const udpErrors = num(rcvErr) + num(rcvBufErr);
  res.json({
    tcpRetransmitsTotal: totalRetrans,
    tcpStatus: totalRetrans > 5000 ? 'red' : totalRetrans > 500 ? 'yellow' : 'green',
    udpReceiveErrors: num(rcvErr),
    udpRcvbufErrors: num(rcvBufErr),
    udpSndbufErrors: num(sndBufErr),
    udpStatus: udpErrors > 1000 ? 'red' : udpErrors > 0 ? 'yellow' : 'green',
    udpQueuesNonEmpty: udpQueues.slice(0, 20),
    raw: { summary: sumR.stdout.trim(), udpStats: snmpR.stdout.trim().slice(0, 5000) },
  });
});

// ---------------------------------------------------------------------------
// TEST 12 — Servicio de ingestión (nginx / systemd / límites)
// ---------------------------------------------------------------------------
router.get('/ingest', async (_req, res) => {
  const [nginxT, nginxConf, rtmpConf, systemdR, limitsR, dockerR] = await Promise.all([
    run('nginx -T 2>/dev/null | head -400 || true', 20000),
    run('cat /etc/nginx/nginx.conf 2>/dev/null || true'),
    run('grep -rn "rtmp\\|worker_connections\\|drop_idle_publisher\\|buflen\\|timeout\\|ping\\|max_message" /etc/nginx/nginx.conf /etc/nginx/conf.d 2>/dev/null | head -60 || true'),
    run('systemctl cat m3u8-emitter.service 2>/dev/null || true'),
    run('cat /proc/$(pgrep -f "node .*server.js" | head -1)/limits 2>/dev/null | head -20 || true'),
    run('docker ps 2>/dev/null | head -10 || true'),
  ]);

  const limits = {};
  ['worker_connections', 'buflen', 'timeout', 'ping', 'max_message', 'drop_idle_publisher', 'chunk_size'].forEach((k) => {
    const m = (nginxConf.stdout + rtmpConf.stdout).match(new RegExp(`${k}\\s+([^;\\n]+)`));
    if (m) limits[k] = m[1].trim();
  });

  const findings = [];
  if (limits.worker_connections && num(limits.worker_connections) < 1024)
    findings.push({ level: 'yellow', msg: `worker_connections=${limits.worker_connections} es bajo.` });
  if (!limits.buflen) findings.push({ level: 'yellow', msg: 'nginx-rtmp sin buflen explícito: con jitter puede cortar publishers.' });
  if (!limits.ping) findings.push({ level: 'yellow', msg: 'nginx-rtmp sin ping/ping_timeout: publishers OBS pueden caer a ~60s de silencio.' });

  res.json({
    nginxPresent: nginxConf.stdout.trim() !== '',
    limits,
    findings,
    status: findings.some((f) => f.level === 'red') ? 'red' : findings.length ? 'yellow' : 'green',
    systemd: systemdR.stdout.trim().slice(0, 4000),
    processLimits: limitsR.stdout.trim(),
    docker: dockerR.stdout.trim(),
    nginxGrep: rtmpConf.stdout.trim().slice(0, 5000),
  });
});

// ---------------------------------------------------------------------------
// Snapshot completo + diagnóstico final con probabilidades
// ---------------------------------------------------------------------------
const localGet = async (path) =>
  new Promise((resolve) => {
    const req2 = http.get({ host: '127.0.0.1', port: process.env.PORT || 3001, path }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    });
    req2.on('error', () => resolve(null));
    req2.setTimeout(30000, () => { req2.destroy(); resolve(null); });
  });

router.get('/summary', async (_req, res) => {
  const [server, nic, sysctl, sockets, ffmpeg, ingest] = await Promise.all([
    localGet('/api/diag/server'),
    localGet('/api/diag/nic'),
    localGet('/api/diag/sysctl'),
    localGet('/api/diag/sockets'),
    localGet('/api/diag/ffmpeg'),
    localGet('/api/diag/ingest'),
  ]);
  res.json({ server, nic, sysctl, sockets, ffmpeg, ingest, stress: stressState, timestamp: Date.now() });
});

// Motor de conclusión: solo usa evidencia disponible; si falta, lo dice.
router.post('/verdict', async (req, res) => {
  const s = req.body || {};
  const ev = [];
  const scores = { servidor: 0, cpu_ram: 0, ffmpeg: 0, isp_local: 0, ruta_peering: 0, udp_mtu_jitter: 0, config_linux: 0, nic: 0 };
  let dataPoints = 0;

  // Servidor / CPU / RAM
  if (s.server) {
    dataPoints++;
    const lr = s.server.cpu?.loadRatio ?? 0;
    const mem = s.server.memory?.usedPercent ?? 0;
    if (lr > 1) { scores.cpu_ram += 30; ev.push(`Load ratio ${lr} (>1): el servidor está saturado de CPU.`); }
    else ev.push(`CPU del servidor sana (load ratio ${lr}, RAM ${mem}%).`);
    if (mem > 92) { scores.cpu_ram += 15; ev.push(`RAM al ${mem}%.`); }
  }

  // NIC
  if (s.nic) {
    dataPoints++;
    if (s.nic.status === 'red') { scores.nic += 30; ev.push(`NIC descartando paquetes (rx ${s.nic.rxDropPercent}% / tx ${s.nic.txDropPercent}%).`); }
    else if (s.nic.status === 'yellow') { scores.nic += 10; ev.push(`NIC con drops/errores menores.`); }
    else ev.push('NIC sin drops ni errores.');
  }

  // Buffers del kernel
  if (s.sysctl) {
    dataPoints++;
    if (s.sysctl.status === 'red') { scores.config_linux += 25; ev.push('Buffers de socket del kernel demasiado pequeños para SRT de alto bitrate.'); }
    else if (s.sysctl.status === 'yellow') { scores.config_linux += 12; ev.push('Buffers del kernel por debajo de lo recomendado para SRT.'); }
  }

  // Sockets
  if (s.sockets) {
    dataPoints++;
    if (s.sockets.udpStatus === 'red') { scores.config_linux += 15; scores.udp_mtu_jitter += 10; ev.push(`Errores de buffer UDP en el kernel (RcvbufErrors=${s.sockets.udpRcvbufErrors}).`); }
    if (s.sockets.tcpStatus !== 'green') { scores.ruta_peering += 10; ev.push(`Retransmisiones TCP acumuladas: ${s.sockets.tcpRetransmitsTotal}.`); }
  }

  // FFmpeg
  if (s.ffmpeg) {
    dataPoints++;
    if (s.ffmpeg.status === 'red') { scores.ffmpeg += 25; ev.push(`FFmpeg consume ${s.ffmpeg.cpuOfMachinePercent}% de la máquina.`); }
    else ev.push(`FFmpeg usando ${s.ffmpeg.cpuOfMachinePercent}% del total de CPU (${s.ffmpeg.count} procesos).`);
  }

  // Stress test (lo más determinante)
  const st = s.stress?.verdict;
  if (st && (st.stableMbps != null || st.tcpMbps != null)) {
    dataPoints += 2;
    if (st.tcpMbps) ev.push(`TCP hacia el servidor alcanza ${st.tcpMbps} Mbps${st.tcpRetransmits != null ? ` (retransmisiones: ${st.tcpRetransmits})` : ''}.`);
    if (st.degradesAtMbps != null) ev.push(`UDP empieza a perder paquetes/jitter desde ${st.degradesAtMbps} Mbps (estable hasta ${st.stableMbps ?? '—'} Mbps).`);
    if (st.tcpMbps && st.degradesAtMbps && st.tcpMbps > st.degradesAtMbps * 2) {
      scores.udp_mtu_jitter += 35;
      ev.push('TCP soporta mucho más que UDP → apunta a tratamiento diferenciado de UDP (shaping, policing o buffers), no a falta de ancho de banda.');
    }
    if (st.tcpMbps && st.tcpMbps < 3) {
      scores.isp_local += 30;
      ev.push('Incluso TCP queda por debajo de 3 Mbps → el enlace/upload real no sostiene el bitrate.');
    }
  }

  // MTU
  if (s.mtu) {
    dataPoints++;
    if (s.mtu.mtu && s.mtu.mtu < 1400) { scores.udp_mtu_jitter += 25; ev.push(`MTU efectivo ${s.mtu.mtu} (<1400): fragmentación probable en SRT.`); }
    else if (s.mtu.mtu) ev.push(`MTU efectivo ${s.mtu.mtu}: sin fragmentación relevante.`);
  }

  // Rutas
  if (s.routeCompare?.clientPath && s.routeCompare?.youtubePath) {
    dataPoints += 2;
    const c = s.routeCompare.clientPath;
    const y = s.routeCompare.youtubePath;
    if (c.avgMs && y.avgMs) {
      ev.push(`Ruta a tu red: ${c.hops} saltos, ${c.avgMs} ms, jitter ${c.jitterMs} ms, pérdida ${c.lossPercent}%. Ruta a YouTube: ${y.hops} saltos, ${y.avgMs} ms, jitter ${y.jitterMs} ms, pérdida ${y.lossPercent}%.`);
      if (c.lossPercent > 1 || (c.jitterMs || 0) > (y.jitterMs || 0) * 2) {
        scores.ruta_peering += 35;
        ev.push('La ruta hacia tu red es claramente peor que la ruta a Google/YouTube → peering/ruta intermedia es la sospecha principal.');
      } else {
        ev.push('Las rutas son comparables: el mejor rendimiento a YouTube no se explica solo por la ruta ICMP.');
      }
    }
  }

  if (dataPoints < 3) {
    return res.json({ enoughData: false, message: 'Datos insuficientes para determinar la causa. Ejecutá al menos: estado del servidor, stress test iperf3 y MTR comparativo.', evidence: ev });
  }

  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  let probabilities;
  if (total === 0) {
    probabilities = null;
    ev.push('Ninguna prueba mostró anomalías: repetí el stress test durante una emisión real para capturar el momento de la degradación.');
  } else {
    probabilities = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Math.round((v / total) * 100)]));
  }

  const topKey = probabilities ? Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0] : null;
  const causeText = {
    servidor: 'F — El servidor no está recibiendo/procesando los datos a tiempo.',
    cpu_ram: 'F — Saturación de CPU/RAM del servidor.',
    ffmpeg: 'G — Configuración/carga de FFmpeg en el servidor.',
    isp_local: 'A/B — Tu enlace o tu ISP no sostiene el bitrate (posible shaping).',
    ruta_peering: 'C/I/J — Ruta/peering entre tu ISP y el datacenter (YouTube va por un peering mejor).',
    udp_mtu_jitter: 'D/E — UDP/SRT sufriendo pérdida, jitter o fragmentación por MTU.',
    config_linux: 'G — Límite de configuración en Linux (buffers de socket/backlog) o en el servicio de ingestión.',
    nic: 'H — La interfaz de red del servidor está descartando paquetes.',
  };

  res.json({
    enoughData: true,
    probabilities,
    topCause: topKey ? causeText[topKey] : null,
    evidence: ev,
    timestamp: Date.now(),
  });
});

// ---------------------------------------------------------------------------
// MONITOR EN VIVO — muestrea una emisión real y saca conclusiones
// ----------------------------------------------------------------------------
// Read-only: solo lee /api/status (telemetría de FFmpeg), /proc/net/dev,
// /proc/net/snmp y load average. No toca la emisión ni la configuración.
// ---------------------------------------------------------------------------
let liveMon = {
  running: false,
  processId: null,
  startedAt: null,
  finishedAt: null,
  durationSec: 0,
  samples: [],
  verdict: null,
  error: null,
};
let liveMonTimer = null;

const readNetDev = async (iface) => {
  const r = await run(`grep -w "${iface}:" /proc/net/dev || true`, 4000);
  const parts = r.stdout.trim().replace(/^.*:/, '').trim().split(/\s+/).map(num);
  // rx: bytes packets errs drop fifo frame compressed multicast | tx: bytes packets errs drop ...
  if (parts.length < 16) return null;
  return {
    rxBytes: parts[0], rxPackets: parts[1], rxErrs: parts[2], rxDrop: parts[3],
    txBytes: parts[8], txPackets: parts[9], txErrs: parts[10], txDrop: parts[11],
  };
};

const readUdpErrors = async () => {
  const r = await run('cat /proc/net/snmp 2>/dev/null | grep -A1 "^Udp:" | tail -1', 4000);
  const p = r.stdout.trim().split(/\s+/);
  // Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors ...
  return { inErrors: num(p[3]), rcvbufErrors: num(p[5]), sndbufErrors: num(p[6]) };
};

const sampleLive = async (pid, iface, prev) => {
  const [statusR, netDev, udp] = await Promise.all([
    localGet(`/api/status?process_id=${encodeURIComponent(pid)}`),
    readNetDev(iface),
    readUdpErrors(),
  ]);
  const live = statusR?.live || null;
  const load = os.loadavg()[0] / (os.cpus().length || 1);
  const s = {
    t: Date.now(),
    status: statusR?.status || 'unknown',
    running: !!statusR?.process_running,
    fps: live?.fps ?? null,
    bitrateKbps: live?.bitrateKbps ?? null,
    speed: live?.speed ?? null,
    dup: live?.dup ?? null,
    drop: live?.drop ?? null,
    q: live?.q ?? null,
    srtRttMs: live?.srtRttMs ?? null,
    srtPktsLost: live?.srtPktsLost ?? null,
    loadRatio: Math.round(load * 100) / 100,
    // deltas por muestra
    dropDelta: prev?.dropRaw != null && live?.drop != null ? Math.max(0, live.drop - prev.dropRaw) : null,
    dupDelta: prev?.dupRaw != null && live?.dup != null ? Math.max(0, live.dup - prev.dupRaw) : null,
    nicRxDropDelta: prev?.netDev && netDev ? netDev.rxDrop - prev.netDev.rxDrop : null,
    nicTxDropDelta: prev?.netDev && netDev ? netDev.txDrop - prev.netDev.txDrop : null,
    udpErrDelta: prev?.udp ? (udp.inErrors + udp.rcvbufErrors) - (prev.udp.inErrors + prev.udp.rcvbufErrors) : null,
  };
  return { sample: s, carry: { dropRaw: live?.drop ?? null, dupRaw: live?.dup ?? null, netDev, udp } };
};

const liveVerdict = (samples) => {
  const withData = samples.filter((s) => s.fps != null || s.bitrateKbps != null);
  if (withData.length < 3) {
    return {
      enoughData: false,
      summary: 'Datos insuficientes: no llegó telemetría de FFmpeg. Verificá que el canal esté realmente emitiendo durante el monitoreo.',
      evidence: [],
      probabilities: null,
    };
  }
  const nums = (k) => withData.map((s) => s[k]).filter((v) => typeof v === 'number');
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const fps = nums('fps');
  const br = nums('bitrateKbps');
  const speed = nums('speed');
  const dropDeltas = withData.map((s) => s.dropDelta).filter((v) => typeof v === 'number');
  const dupDeltas = withData.map((s) => s.dupDelta).filter((v) => typeof v === 'number');
  const nicDrops = withData.map((s) => (s.nicRxDropDelta || 0) + (s.nicTxDropDelta || 0)).filter((v) => typeof v === 'number');
  const udpErrs = withData.map((s) => s.udpErrDelta).filter((v) => typeof v === 'number');

  const fpsAvg = Math.round(avg(fps) * 10) / 10;
  const fpsMin = fps.length ? Math.min(...fps) : null;
  const brAvg = Math.round(avg(br));
  const brMin = br.length ? Math.min(...br) : null;
  const brStd = br.length > 1 ? Math.sqrt(avg(br.map((v) => (v - avg(br)) ** 2))) : 0;
  const speedAvg = Math.round(avg(speed) * 100) / 100;
  const dropTotal = dropDeltas.reduce((a, b) => a + b, 0);
  const dupTotal = dupDeltas.reduce((a, b) => a + b, 0);
  const nicDropTotal = nicDrops.reduce((a, b) => a + b, 0);
  const udpErrTotal = udpErrs.reduce((a, b) => a + b, 0);
  const restarts = samples.filter((s) => s.status === 'starting' || s.status === 'error').length;

  const scores = { encoder_fuente: 0, isp_subida: 0, ruta_peering: 0, servidor: 0, nic: 0, config_linux: 0, ok: 0 };
  const ev = [];

  if (fpsMin != null && fpsMin < 25) {
    ev.push(`FPS cayó a ${fpsMin} (promedio ${fpsAvg}): la señal que llega al VPS se está quedando sin frames.`);
    scores.encoder_fuente += 2; scores.isp_subida += 2;
  } else if (fpsAvg) {
    ev.push(`FPS estable en ${fpsAvg} durante todo el monitoreo.`);
    scores.ok += 1;
  }

  if (brAvg && brMin != null && brMin < brAvg * 0.6) {
    ev.push(`Bitrate cayó de ~${brAvg} kbps a ${brMin} kbps: el enlace de subida no sostiene el caudal (shaping/congestión).`);
    scores.isp_subida += 3;
  }
  if (brAvg && brStd > brAvg * 0.25) {
    ev.push(`Bitrate muy inestable (desvío ${Math.round(brStd)} kbps sobre ${brAvg} kbps): típico de jitter en la ruta.`);
    scores.ruta_peering += 2;
  }
  if (dropTotal > 0) {
    ev.push(`FFmpeg descartó ${dropTotal} frames durante el monitoreo: llegan tarde o corruptos desde el encoder.`);
    scores.isp_subida += 2; scores.ruta_peering += 1;
  }
  if (dupTotal > 0) {
    ev.push(`FFmpeg duplicó ${dupTotal} frames: la fuente entrega menos FPS de los esperados (hueco en la entrada).`);
    scores.encoder_fuente += 2;
  }
  if (nicDropTotal > 0) {
    ev.push(`La NIC del VPS descartó ${nicDropTotal} paquetes: el problema es del servidor, no de tu red.`);
    scores.nic += 3;
  }
  if (udpErrTotal > 0) {
    ev.push(`${udpErrTotal} errores UDP en el kernel (buffers): subir rmem_max/wmem_max ayudaría a SRT.`);
    scores.config_linux += 3;
  }
  const loadMax = Math.max(...samples.map((s) => s.loadRatio || 0));
  if (loadMax > 0.85) {
    ev.push(`Carga del servidor llegó a ${Math.round(loadMax * 100)}% de sus núcleos.`);
    scores.servidor += 3;
  }
  if (speedAvg && speedAvg < 0.97) {
    ev.push(`speed=${speedAvg}x: FFmpeg va más lento que tiempo real (se acumula retraso).`);
    scores.servidor += 2; scores.encoder_fuente += 1;
  }
  if (restarts > 0) {
    ev.push(`Se detectaron ${restarts} muestras en estado starting/error: hubo cortes/reconexiones durante el monitoreo.`);
    scores.isp_subida += 2;
  }
  if (!ev.length) ev.push('Sin anomalías: la emisión se mantuvo estable en toda la ventana medida.');

  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  const probabilities = total
    ? Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Math.round((v / total) * 100)]))
    : null;
  const topKey = probabilities ? Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0] : null;
  const causeText = {
    encoder_fuente: 'El encoder/fuente (Pearl Nano, OBS o el origen HLS) no entrega frames de forma continua.',
    isp_subida: 'Tu enlace de subida / ISP no sostiene el bitrate hacia el VPS (shaping o congestión).',
    ruta_peering: 'Ruta/peering entre tu ISP y el datacenter: jitter que degrada el flujo.',
    servidor: 'El VPS se está quedando corto de CPU o va más lento que tiempo real.',
    nic: 'La interfaz de red del VPS está descartando paquetes.',
    config_linux: 'Buffers de socket del kernel demasiado chicos para SRT/UDP.',
    ok: 'Todo estable: no hay evidencia de pérdida en esta ventana.',
  };

  return {
    enoughData: true,
    metrics: { fpsAvg, fpsMin, brAvg, brMin, brStdKbps: Math.round(brStd), speedAvg, dropTotal, dupTotal, nicDropTotal, udpErrTotal, restarts, loadMax },
    probabilities,
    summary: topKey ? causeText[topKey] : null,
    evidence: ev,
  };
};

router.get('/live/state', (_req, res) => res.json(liveMon));

router.post('/live/start', async (req, res) => {
  if (liveMon.running) return res.status(409).json({ error: 'Ya hay un monitoreo en curso.' });
  const pid = String(req.body?.processId ?? '').trim();
  if (!/^\d{1,3}$/.test(pid)) return res.status(400).json({ error: 'processId inválido.' });
  const durationSec = Math.min(600, Math.max(30, parseInt(req.body?.durationSec, 10) || 120));
  const iface = await defaultIface();

  liveMon = { running: true, processId: pid, startedAt: Date.now(), finishedAt: null, durationSec, samples: [], verdict: null, error: null };
  let carry = null;
  const endAt = Date.now() + durationSec * 1000;

  const tick = async () => {
    try {
      const { sample, carry: next } = await sampleLive(pid, iface, carry);
      carry = next;
      liveMon.samples.push(sample);
    } catch (err) {
      liveMon.error = err?.message || String(err);
    }
    if (!liveMon.running) return;
    if (Date.now() >= endAt) {
      liveMon.running = false;
      liveMon.finishedAt = Date.now();
      liveMon.verdict = liveVerdict(liveMon.samples);
      liveMonTimer = null;
      return;
    }
    liveMonTimer = setTimeout(tick, 2000);
  };
  tick();
  res.json({ started: true, processId: pid, durationSec, iface });
});

router.post('/live/stop', (_req, res) => {
  if (liveMonTimer) { clearTimeout(liveMonTimer); liveMonTimer = null; }
  if (liveMon.running) {
    liveMon.running = false;
    liveMon.finishedAt = Date.now();
    liveMon.verdict = liveVerdict(liveMon.samples);
  }
  res.json(liveMon);
});

export default router;
