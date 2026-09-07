const FALLBACK_VPS_HOST = "167.17.69.116";

export function getVpsHost(): string {
  if (typeof window === "undefined") return FALLBACK_VPS_HOST;
  const h = window.location.hostname;
  if (
    !h ||
    h === "localhost" ||
    h === "127.0.0.1" ||
    h.endsWith(".lovable.app") ||
    h.endsWith(".lovableproject.com")
  ) {
    return FALLBACK_VPS_HOST;
  }
  return h;
}

export function apiUrl(path: string): string {
  if (path.startsWith("http")) return path;
  const base = `http://${getVpsHost()}:3001`;
  return `${base}${path}`;
}
