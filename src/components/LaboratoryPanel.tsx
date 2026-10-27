import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, Play, Square, ShieldCheck, RefreshCw, CheckCircle2, AlertTriangle, Clock, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiUrl } from '@/lib/apiUrl';

type Result = { profile: string; speed: number; videoKbps: number; sizeMB: number; elapsed: number };
type Profile = { id: string; label: string; purpose: string; experimental: boolean; videoKbps: number; audioKbps: number; height: number };
type Job = { id: string; channel: string; status: string; stage: string; startedAt: string; profiles?: Profile[]; results?: Result[]; conclusion?: string; error?: string; sample?: { seconds: number }; reference?: { width: number; height: number; codec: string } };
type Channel = { id: string; name: string; running: boolean; provider?: string; profile?: string };
type LabData = { channels: Channel[]; active: Job | null; history: Job[]; profiles?: Profile[] };
const names: Record<string, string> = { normal: 'Normal', normalpro: 'Normal Mejorado Pro', sportsdetail: 'Deportes Detalle 2000', sportsclean: 'Deportes Limpio 2000' };
const plannedProfiles: Profile[] = [
  { id: 'normal', label: names.normal, purpose: 'Referencia actual', experimental: false, videoKbps: 2000, audioKbps: 128, height: 720 },
  { id: 'normalpro', label: names.normalpro, purpose: 'Referencia de compresión mejorada', experimental: false, videoKbps: 2000, audioKbps: 128, height: 720 },
  { id: 'sportsdetail', label: names.sportsdetail, purpose: 'Sin filtro de ruido; prueba de detalle y menor esfuerzo', experimental: true, videoKbps: 2000, audioKbps: 128, height: 720 },
  { id: 'sportsclean', label: names.sportsclean, purpose: 'Filtro espacial leve, sin suavizado temporal; prueba para fuentes con ruido', experimental: true, videoKbps: 2000, audioKbps: 128, height: 720 },
];
const time = (value: string) => new Date(value).toLocaleString('es-CR', { timeZone: 'America/Costa_Rica', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export function LaboratoryPanel() {
  const [data, setData] = useState<LabData | null>(null);
  const [channel, setChannel] = useState('futv');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const request = useCallback(async (path = '', body?: object) => {
    const response = await fetch(apiUrl(`/api/laboratory${path}`), {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Auth': sessionStorage.getItem('m3u8_dashboard_auth') || '' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000),
    });
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Laboratorio todavía no está disponible en el servidor. Actualiza el VPS para habilitar las pruebas.');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo consultar Laboratorio.');
    return result;
  }, []);
  const refresh = useCallback(async () => {
    try { setData(await request()); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'No se pudo conectar con el servidor. Si todavía no lo actualizaste, Laboratorio se habilitará después de actualizarlo.'); }
    finally { setLoading(false); }
  }, [request]);
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, [refresh]);
  const action = async (path: string) => {
    setPending(true);
    try { await request(path, path === '/start' ? { channel } : {}); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'No se pudo completar la acción.'); }
    finally { setPending(false); }
  };
  const selected = data?.channels.find(c => c.id === channel);
  const latest = data?.history[0];
  const profiles = data?.profiles || plannedProfiles;
  const steps = ['capture', ...(data?.active?.profiles || profiles).map(p => p.id)];
  return <section className="text-foreground space-y-6 py-4">
    <div className="flex flex-wrap justify-between items-start gap-4 border-b border-border pb-6">
      <div><div className="flex items-center gap-3"><FlaskConical className="h-7 w-7 text-primary" /><h2 className="text-2xl font-semibold">Laboratorio</h2></div><p className="text-muted-foreground mt-2 text-sm">FUTV y FOX · Comparación de salida</p></div>
      <div className="flex items-center gap-2 text-success text-sm"><ShieldCheck className="h-4 w-4" />Emisiones sin cambios</div>
    </div>
    {error && <div role="alert" className="flex items-start gap-3 border border-warning/30 bg-warning/10 p-4 rounded-md"><AlertTriangle className="h-5 w-5 shrink-0 text-warning" /><p className="text-sm flex-1">{error}</p><Button variant="ghost" size="icon" title="Volver a consultar" aria-label="Volver a consultar" onClick={() => void refresh()}><RefreshCw /></Button></div>}
    <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-8">
      <div className="space-y-5">
        <h3 className="font-semibold">Nueva prueba</h3>
        <label className="block space-y-2"><span className="text-sm text-muted-foreground">Canal</span><Select value={channel} onValueChange={setChannel} disabled={!!data?.active || pending}><SelectTrigger aria-label="Canal de prueba"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="futv">FUTV</SelectItem><SelectItem value="fox">FOX</SelectItem></SelectContent></Select></label>
        <div className="flex flex-wrap gap-3 text-sm"><span className={selected?.running ? 'text-success' : 'text-muted-foreground'}><Radio className="inline h-4 w-4 mr-1" />{selected?.running ? 'Señal activa' : loading ? 'Consultando señal…' : data ? 'Señal detenida' : 'Sin conexión'}</span>{selected?.running && <><span>{selected.provider}</span><span className="text-muted-foreground">{names[selected.profile || ''] || selected.profile}</span></>}</div>
        <dl className="grid grid-cols-2 gap-y-4 border-y border-border py-4 text-sm"><div><dt className="text-muted-foreground">Muestra compartida</dt><dd className="font-semibold mt-1">Hasta 30 segundos</dd></div><div><dt className="text-muted-foreground">Video de todas las salidas</dt><dd className="font-semibold mt-1">2000 kbps · 720p</dd></div><div><dt className="text-muted-foreground">Comparación</dt><dd className="mt-1">{profiles.length} salidas, una por una</dd></div><div><dt className="text-muted-foreground">Audio</dt><dd className="mt-1">128 kbps · 48 kHz</dd></div></dl>
        <ul className="divide-y divide-border">{profiles.map(profile => <li key={profile.id} className="py-3"><div className="flex flex-wrap items-center gap-2 text-sm font-medium">{profile.label}{profile.experimental && <span className="text-xs text-warning font-normal">Experimental · solo laboratorio</span>}</div><p className="text-xs text-muted-foreground mt-1">{profile.purpose}</p></li>)}</ul>
        <Button className="w-full sm:w-auto" disabled={!selected?.running || !!data?.active || pending || !!error} onClick={() => void action('/start')}><Play />Iniciar prueba</Button>
        <p className="text-xs text-muted-foreground">Referencia: fragmentos de la salida actual, ya procesados. No es la fuente original ni una medición de XUI.</p>
      </div>
      <div className="space-y-4 md:border-l md:border-border md:pl-8">
        <h3 className="font-semibold">Prueba en curso</h3>
        {data?.active ? <div className="space-y-5"><div className="flex gap-2 items-center text-primary"><RefreshCw className="h-4 w-4 animate-spin motion-reduce:animate-none" />{data.active.stage === 'capture' ? 'Preparando muestra' : `Procesando ${names[data.active.stage] || data.active.stage}`}</div><p className="text-sm">{data.active.channel.toUpperCase()} · {time(data.active.startedAt)}</p><div className="flex gap-1" aria-label="Progreso de prueba">{steps.map((step, i) => <span key={step} className={`h-1.5 flex-1 rounded-sm ${i <= steps.indexOf(data.active?.stage || '') ? 'bg-primary' : 'bg-muted'}`} />)}</div><Button variant="outline" disabled={pending} onClick={() => void action('/cancel')}><Square />Cancelar prueba</Button></div>
        : <div className="py-8 text-muted-foreground flex items-center gap-3"><Clock className="h-6 w-6" /><span className="text-sm">{loading ? 'Consultando laboratorio…' : 'Sin pruebas en curso'}</span></div>}
        <div className="border-t border-border pt-4 text-xs text-muted-foreground space-y-2"><p>Una prueba a la vez · prioridad baja · dos hilos de codificación.</p><p>Los videos temporales se eliminan; los resultados duran 48 horas.</p><p>La prueba usa algo de CPU y disco. Se bloquea cuando falta margen para las emisiones.</p></div>
      </div>
    </div>
    <div className="border-t border-border pt-6 space-y-4"><h3 className="font-semibold">Resultados</h3>
      {!latest ? <p className="text-sm text-muted-foreground py-8">Todavía no hay resultados.</p> : data?.history.map(job => <article key={job.id} className="border border-border rounded-md p-4 space-y-4 bg-card">
        <div className="flex flex-wrap justify-between gap-2"><div className="flex gap-2 items-center">{job.status === 'completed' ? <CheckCircle2 className="h-4 w-4 text-success" /> : <AlertTriangle className="h-4 w-4 text-warning" />}<span className="font-semibold">{job.channel.toUpperCase()}</span><span className="text-xs text-muted-foreground">{job.status === 'completed' ? 'Completada' : job.status === 'cancelled' ? 'Cancelada' : 'No completada'}</span></div><span className="text-xs text-muted-foreground">{time(job.startedAt)} · Costa Rica</span></div>
        {job.sample && <p className="text-xs text-muted-foreground">Muestra: {job.sample.seconds.toFixed(1)} s {job.reference ? `· ${job.reference.width} × ${job.reference.height} · ${job.reference.codec}` : ''}</p>}
        {!!job.results?.length && <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead className="text-xs text-muted-foreground"><tr><th className="py-2 pr-4 font-normal">Salida</th><th className="pr-4 font-normal">Velocidad de prueba</th><th className="pr-4 font-normal">Video medido</th><th className="font-normal">Tamaño</th></tr></thead><tbody>{job.results.map(r => <tr key={r.profile} className="border-t border-border"><td className="py-3 pr-4">{job.profiles?.find(p => p.id === r.profile)?.label || names[r.profile] || r.profile}</td><td className="pr-4 font-mono">{r.speed.toFixed(2)}×</td><td className="pr-4 font-mono">{r.videoKbps ? `${Math.round(r.videoKbps)} kbps` : 'No disponible'}</td><td className="font-mono">{r.sizeMB.toFixed(1)} MB</td></tr>)}</tbody></table></div>}
        <p className="text-sm leading-relaxed">{job.error || job.conclusion}</p>
      </article>)}
    </div>
  </section>;
}
