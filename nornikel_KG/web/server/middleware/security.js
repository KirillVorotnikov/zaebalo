import { configManager } from '../services/configManager.js';

function getSecuritySettings() {
  return configManager.settings?.security ?? {};
}

export function getConfiguredApiKey() {
  return process.env.K2_18_WEB_API_KEY || getSecuritySettings().apiKey || '';
}

/**
 * Optional shared-secret gate for high-impact routes (ACCELMAT pipeline runs,
 * Feynman chat sessions with full bash/read/write access). Disabled by default
 * for local-only development; set `security.apiKey` in settings.json or the
 * K2_18_WEB_API_KEY env var to require `X-Api-Key` on these routes.
 */
export function requireApiKey(req, res, next) {
  const configuredKey = getConfiguredApiKey();
  if (!configuredKey) {
    next();
    return;
  }
  const providedKey = req.headers['x-api-key'];
  if (providedKey !== configuredKey) {
    res.status(401).json({ error: 'Missing or invalid X-Api-Key header' });
    return;
  }
  next();
}

/**
 * Minimal in-memory sliding-window rate limiter, scoped per client IP (or
 * X-Session-Id when present, which better matches how this app already
 * identifies clients than raw IP behind a shared dev proxy).
 */
export function rateLimit({ windowMs, max, message }) {
  const hits = new Map();

  return (req, res, next) => {
    const key = req.headers['x-session-id'] || req.ip || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;
    const timestamps = (hits.get(key) ?? []).filter((t) => t > windowStart);

    if (timestamps.length >= max) {
      res.status(429).json({ error: message ?? 'Too many requests, please slow down.' });
      return;
    }

    timestamps.push(now);
    hits.set(key, timestamps);
    next();
  };
}

export function warnIfApiKeyMissing() {
  if (!getConfiguredApiKey()) {
    console.warn(
      '[security] No K2_18_WEB_API_KEY / settings.security.apiKey configured. ' +
      '/api/accelmat and /api/feynman routes (pipeline execution, full-agent chat with bash/read/write) ' +
      'are unauthenticated. Fine for localhost-only use; set an API key before exposing this server beyond localhost.',
    );
  }
}
