const FIRST_REFRESH_LEAD_MS = 10 * 60_000;
const RETRY_LEAD_MS = 5 * 60_000;

type Credential = { expiresAt: number; refreshToken: string };

export function createTokenRefreshScheduler(label: string, refresh: (name: string) => Promise<Credential>) {
  const timers = new Map<string, { expiresAt: number; timer: NodeJS.Timeout }>();

  function schedule(name: string, credential: Credential, minDelay = 0) {
    if (!credential.refreshToken || !Number.isFinite(credential.expiresAt) || timers.get(name)?.expiresAt === credential.expiresAt) return;
    cancel(name);

    const retryAt = credential.expiresAt - RETRY_LEAD_MS;
    const canRetry = Date.now() < retryAt;
    const arm = (at: number, attempt: number) => {
      const timer = setTimeout(async () => {
        try {
          await refresh(name);
        } catch (error) {
          console.error(`[${label}] refresh failed for ${name} (background attempt ${attempt}):`, error);
          if (attempt === 1 && canRetry && timers.get(name)?.timer === timer) {
            console.info(`[${label}] refresh retry scheduled for ${name}: ${new Date(Math.max(Date.now(), retryAt)).toISOString()}`);
            arm(retryAt, 2);
          }
        }
      }, Math.max(0, at - Date.now()));
      timers.set(name, { expiresAt: credential.expiresAt, timer });
    };
    arm(Math.max(Date.now() + minDelay, credential.expiresAt - FIRST_REFRESH_LEAD_MS), 1);
  }

  function cancel(name: string) {
    const entry = timers.get(name);
    if (entry) clearTimeout(entry.timer);
    timers.delete(name);
  }

  function retain(providers: ReadonlyMap<string, unknown>) {
    for (const name of timers.keys()) if (!providers.has(name)) cancel(name);
  }

  function refreshed(name: string, previous: Credential, next: Credential, refreshTokenReturned: boolean) {
    console.info(`[${label}] refresh succeeded for ${name}`, {
      refreshedAt: new Date().toISOString(),
      previousAccessTokenExpiresAt: new Date(previous.expiresAt).toJSON(),
      accessTokenExpiresAt: new Date(next.expiresAt).toJSON(),
      refreshTokenReturned,
      refreshTokenChanged: next.refreshToken !== previous.refreshToken,
    });
    cancel(name);
    schedule(name, next, 30_000);
  }

  return { schedule, retain, refreshed };
}
