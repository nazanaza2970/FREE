import { EventEmitter } from 'node:events';
import type { AuditLog } from '../shared/types';

/**
 * In-process pub/sub for audit events. `db.addAudit` emits here after each
 * insert, so any number of consumers (SSE streams, JSONL tailers, M9 sync)
 * can subscribe without coupling to the database.
 */
export const auditBus = new EventEmitter();
auditBus.setMaxListeners(1000);

export type AuditEvent = 'audit';

export function emitAudit(record: AuditLog): void {
  auditBus.emit('audit', record);
}

export function onAudit(listener: (record: AuditLog) => void): () => void {
  auditBus.on('audit', listener);
  return () => auditBus.off('audit', listener);
}
