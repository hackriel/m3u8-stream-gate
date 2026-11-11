// A sent signal (ChildProcess.killed) is not proof that FFmpeg exited.
export function hasProcessExited(child) {
  return !child || child.exitCode != null || child.signalCode != null;
}

export function recoveryWorkExists(child, active, queued) {
  return Boolean((child && !hasProcessExited(child)) || active || queued);
}

export function positiveVideoFrame(output) {
  const frames = Array.from(output.matchAll(/frame=\s*(\d+)/g), match => Number(match[1]));
  return frames.length ? Math.max(...frames) : 0;
}

export function tdmaxProbeSettings(source, recovery, stable) {
  let tdmax = false;
  try {
    const url = new URL(source);
    tdmax = /(^|\.)teletica\.com$/i.test(url.hostname) && !url.pathname.toLowerCase().includes('/teleticalivestream/');
  } catch {}
  // Recovering at the live edge may start between keyframes: retain enough
  // input analysis to acquire H264 SPS/PPS rather than favoring fast probing.
  if (tdmax || stable) return { analyzeDuration: '3000000', probeSize: '2000000' };
  return { analyzeDuration: recovery ? '1500000' : '3000000', probeSize: recovery ? '500000' : '1500000' };
}

export async function terminateForRecovery(child, waitForDeath) {
  if (hasProcessExited(child)) return true;
  child.kill('SIGTERM');
  await waitForDeath(child, 2000); // existing waiter escalates to SIGKILL
  return hasProcessExited(child);
}