import {
  applyRemoteEntity,
  clearQueue,
  collectPending,
  countPending,
  getDb,
  getMetaRev,
  recordMeta,
} from '../db';
import type Database from '../sqlite';
import type { SyncEntity, SyncMergeResult, SyncState } from '../../shared/types';

export interface SyncClientConfig {
  serverUrl: string;
  deviceId: string;
  deviceName: string;
  token: string;
}

function headers(token: string): Record<string, string> {
  const base: Record<string, string> = { 'content-type': 'application/json' };
  if (token) base.authorization = `Bearer ${token}`;
  return base;
}

/** Thin client for the standalone sync server. */
export class SyncClient {
  constructor(private cfg: SyncClientConfig) {}

  private url(pathname: string): string {
    return `${this.cfg.serverUrl.replace(/\/+$/, '')}/sync${pathname}`;
  }

  private async call<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url(pathname), {
      method,
      headers: headers(this.cfg.token),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = `HTTP ${res.status}`;
      try {
        message = (JSON.parse(text) as { error?: string }).error || message;
      } catch {
        /* keep status text */
      }
      throw new Error(message);
    }
    return (await res.json()) as T;
  }

  register(): Promise<unknown> {
    return this.call('POST', '/register', { deviceId: this.cfg.deviceId, name: this.cfg.deviceName });
  }

  push(entities: SyncEntity[]): Promise<{ accepted: number; state: SyncState }> {
    return this.call('POST', '/push', { entities });
  }
}

/**
 * One merge round: register -> push queued entities -> apply newer remote
 * entities (LWW) -> clear the offline queue. Never throws on network errors;
 * those are reported so the UI can show the queue.
 */
export async function syncNow(
  database: Database.Database = getDb(),
  config: SyncClientConfig = {
    serverUrl: '',
    deviceId: '',
    deviceName: '',
    token: '',
  },
): Promise<SyncMergeResult> {
  const base: SyncMergeResult = {
    ok: false,
    pushed: 0,
    pulled: 0,
    pending: countPending(database),
    deviceId: config.deviceId,
  };
  const client = new SyncClient(config);
  try {
    await client.register();
    const queued = collectPending(database);
    const { state } = await client.push(queued);
    let pulled = 0;
    for (const entity of state.entities) {
      const meta = getMetaRev(database, entity.type, entity.id);
      const rev = entity.rev ?? 1;
      if (!meta || rev > meta.rev) {
        if (applyRemoteEntity(database, entity)) {
          recordMeta(database, entity.type, entity.id, rev, entity.updated_at_ms);
          pulled++;
        }
      }
    }
    if (queued.length) clearQueue(database, queued.map((e) => ({ type: e.type, id: e.id })));
    return {
      ok: true,
      pushed: queued.length,
      pulled,
      pending: countPending(database),
      deviceId: config.deviceId,
      serverTime: state.server_time,
    };
  } catch (err) {
    return { ...base, pending: countPending(database), error: err instanceof Error ? err.message : String(err) };
  }
}
