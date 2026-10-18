/**
 * Proxy from the environment for requests to `targetUrl`: `HTTPS_PROXY`, then `HTTP_PROXY`, unless the target host
 * is listed in `NO_PROXY` (or `no_proxy`). Explicitly configured proxies are resolved by the caller and always win.
 */
export function resolveEnvProxy(targetUrl: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const proxy = env.HTTPS_PROXY || env.HTTP_PROXY;
  if (!proxy) return undefined;
  return bypassesProxy(targetUrl, env.NO_PROXY ?? env.no_proxy ?? "") ? undefined : proxy;
}

/**
 * `NO_PROXY` matching as curl does it: comma or space separated entries, `*` bypasses everything, a domain matches
 * itself and its subdomains (a leading `.` or `*.` is ignored), and an entry with a port only matches that port.
 */
export function bypassesProxy(targetUrl: string, noProxy: string): boolean {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }
  const host = stripBrackets(url.hostname.toLowerCase());
  const port = url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
  return noProxy.split(/[\s,]+/).some((rawEntry) => {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) return false;
    if (entry === "*") return true;
    const { host: entryHost, port: entryPort } = splitHostPort(entry);
    if (entryPort && entryPort !== port) return false;
    const domain = entryHost.replace(/^\*?\./, "");
    return domain !== "" && (host === domain || host.endsWith("." + domain));
  });
}

function splitHostPort(entry: string): { host: string; port?: string } {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (bracketed) return { host: bracketed[1], port: bracketed[2] };
  // More than one colon is a bare IPv6 address, which cannot carry a port without brackets.
  const parts = entry.split(":");
  if (parts.length === 2 && /^\d+$/.test(parts[1])) return { host: parts[0], port: parts[1] };
  return { host: entry };
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}
