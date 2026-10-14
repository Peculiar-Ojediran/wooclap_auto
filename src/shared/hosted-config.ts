// Only this public service URL is embedded at build time. The operator's NVIDIA
// key belongs in the hosted service secret store, never in an extension build.
declare const __HOSTED_FALLBACK_URL__: string | undefined;
export const HOSTED_FALLBACK_URL = typeof __HOSTED_FALLBACK_URL__ === 'string' ? __HOSTED_FALLBACK_URL__ : '';

export function hostedBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || url.port || !url.hostname.includes('.') || url.hostname.endsWith('.localhost')
    || url.hostname === 'localhost' || url.hostname.startsWith('[') || /^[\d.]+$/.test(url.hostname)) {
    throw new Error('HOSTED_FALLBACK_URL must be a public HTTPS origin without credentials, a path, or a port.');
  }
  return url.origin;
}
