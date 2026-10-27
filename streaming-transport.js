// Telecable EOF belongs to a completed HTTP segment, not the end of live TV.
// Never reconnect that segment by byte offset; let the HLS demuxer reload.
export function telecableInputArgs() {
  return ['-rw_timeout', '15000000', '-reconnect', '1', '-reconnect_on_http_error', '5xx', '-reconnect_delay_max', '3'];
}
export function classifyStreamFailure(text) {
  if (/error writing|av_interleaved_write_frame|broken pipe|error opening output|failed to update header/i.test(text)) return 'output';
  if (/HTTP error|failed to reload playlist|error when loading|error in the pull function|end of file|\bEOF\b/i.test(text)) return 'input';
  if (/non.monoton|invalid.*timestamp/i.test(text)) return 'timestamps';
  return 'unknown';
}