import { createServer } from "node:net";

// Windows lets sockets on different local addresses share a port (a listener on 0.0.0.0 does not block ::),
// so a port only counts as free when each address a local client may reach is free. undefined is the
// default bind the gateway itself uses.
const PROBE_HOSTS = ["0.0.0.0", "127.0.0.1", "::1", undefined];

/** Resolves false only when the port is taken; other errors (such as no IPv6 on the machine) don't count. */
function isFreeOn(port: number, host: string | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code !== "EADDRINUSE" && error.code !== "EACCES"));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

async function isFree(port: number): Promise<boolean> {
  for (const host of PROBE_HOSTS) {
    if (!(await isFreeOn(port, host))) return false;
  }
  return true;
}

/** The first port from `start` that nothing listens on; `start` itself when none of `attempts` ports is free. */
export async function findAvailablePort(start: number, attempts = 100): Promise<number> {
  for (let port = start; port < start + attempts && port <= 65535; port += 1) {
    if (await isFree(port)) return port;
  }
  return start;
}
