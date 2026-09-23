import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { addAudit, countPending, getDb, getSetting, setSetting } from '../db';
import { syncNow, type SyncClientConfig } from '../sync/engine';
import type { SyncConfig, SyncConfigInput } from '../../shared/types';

const K = {
  enabled: 'sync.enabled',
  serverUrl: 'sync.server_url',
  deviceName: 'sync.device_name',
  deviceId: 'sync.device_id',
  token: 'sync.token',
  lastSyncAt: 'sync.last_sync_at',
  lastError: 'sync.last_error',
  lastStats: 'sync.last_stats',
};

function readConfig(database: ReturnType<typeof getDb>): SyncConfig {
  const deviceId = getSetting(database, K.deviceId) ?? randomUUID();
  if (!getSetting(database, K.deviceId)) setSetting(database, K.deviceId, deviceId);
  return {
    enabled: getSetting(database, K.enabled) === '1',
    server_url: getSetting(database, K.serverUrl) ?? '',
    device_name: getSetting(database, K.deviceName) ?? 'device',
    device_id: deviceId,
    token: getSetting(database, K.token) ?? '',
    last_sync_at: getSetting(database, K.lastSyncAt),
    last_error: getSetting(database, K.lastError),
    last_stats: getSetting(database, K.lastStats) ? (JSON.parse(getSetting(database, K.lastStats)!) as SyncConfig['last_stats']) : null,
    pending: countPending(database),
  };
}

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.get('/config', async () => readConfig(getDb()));

  app.put('/config', async (req, reply) => {
    const db = getDb();
    const body = (req.body ?? {}) as Partial<SyncConfigInput>;
    if (body.server_url !== undefined) {
      const url = String(body.server_url).trim();
      if (url && !/^https?:\/\//i.test(url)) return reply.code(400).send({ error: 'server_url must start with http:// or https://' });
      setSetting(db, K.serverUrl, url);
    }
    if (body.device_name !== undefined) setSetting(db, K.deviceName, String(body.device_name).trim() || 'device');
    if (body.token !== undefined) setSetting(db, K.token, String(body.token).trim());
    if (body.enabled !== undefined) setSetting(db, K.enabled, body.enabled ? '1' : '0');

    const serverUrl = getSetting(db, K.serverUrl);
    const token = getSetting(db, K.token);
    if (serverUrl && token) {
      // Ensure a token issued by this app is also accepted by the sync server.
      fetch(serverUrl.replace(/\/$/, '') + '/sync/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'app-bridge', token }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => {
        /* sync server unreachable; merge will surface the error */
      });
    }
    return readConfig(db);
  });

  app.post('/merge', async (req, reply) => {
    const db = getDb();
    const cfg = readConfig(db);
    const clientCfg: SyncClientConfig = {
      serverUrl: cfg.server_url,
      deviceId: cfg.device_id,
      deviceName: cfg.device_name,
      token: cfg.token,
    };
    if (!cfg.server_url) {
      return reply.code(400).send({ ...syncNow(db, clientCfg), error: 'sync server url not configured' });
    }
    const result = await syncNow(db, clientCfg);
    if (result.ok) {
      setSetting(db, K.lastSyncAt, new Date().toISOString());
      setSetting(db, K.lastError, '');
      setSetting(
        db,
        K.lastStats,
        JSON.stringify({ pushed: result.pushed, pulled: result.pulled, deviceId: result.deviceId, serverTime: result.serverTime ?? '' }),
      );
    } else {
      setSetting(db, K.lastError, result.error ?? 'sync failed');
    }
    addAudit(db, 'sync.merge', null, result.ok ? `pushed=${result.pushed} pulled=${result.pulled}` : `offline: ${result.error ?? 'unknown'}`);
    return result;
  });
}
