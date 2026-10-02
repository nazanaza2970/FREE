import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { Readable, Writable } from 'node:stream';
import { Client, type ConnectConfig, type FileEntryWithStats, type SFTPWrapper, type Stats } from 'ssh2';
import { addAudit, getDb, getHost, getKnownHost, upsertKnownHost } from './db';
import { buildAuthConfig } from './ssh/auth';
import { hostKeyAlg, hostKeyFingerprint } from './ssh/known_hosts';
import type { SftpClientMessage, SftpEntry, SftpServerMessage } from '../shared/sftp';
import { encodeBase64, decodeBase64 } from '../shared/protocol';

const DATA_CHUNK = 256 * 1024;

interface Transfer {
  id: string;
  op: 'upload' | 'download';
  stream: Readable | Writable;
  name: string;
  transferred: number;
  total: number;
  cancelled?: boolean;
}

interface SftpSession {
  ws: WebSocket;
  hostId: number;
  conn: Client | null;
  sftp: SFTPWrapper | null;
  cwd: string;
  transfers: Map<string, Transfer>;
  closed: boolean;
}

function send(ws: WebSocket, msg: SftpServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function fail(ws: WebSocket, message: string, id?: string): void {
  send(ws, { type: 'error', message, ...(id ? { id } : {}) });
}

function entryFromAttrs(name: string, dir: string, attrs: Stats): SftpEntry {
  let type: SftpEntry['type'] = 'other';
  if (attrs.isDirectory()) type = 'directory';
  else if (attrs.isSymbolicLink()) type = 'symlink';
  else if (attrs.isFile()) type = 'file';
  return {
    name,
    path: dir === '/' ? `/${name}` : `${dir}/${name}`,
    type,
    size: attrs.size ?? 0,
    mode: attrs.mode ?? 0,
    uid: attrs.uid ?? 0,
    gid: attrs.gid ?? 0,
    mtime: attrs.mtime ?? 0,
  };
}

function toPromise<T>(fn: (cb: (err: Error | undefined, result: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, result) => (err ? reject(err) : resolve(result)));
  });
}

function removeRecursive(sftp: SFTPWrapper, path: string): Promise<void> {
  return toPromise<Stats>((cb) => sftp.stat(path, (e, s) => cb(e, s))).then((attrs) => {
    if (attrs.isDirectory()) {
      return toPromise<FileEntryWithStats[]>((cb) => sftp.readdir(path, (e, l) => cb(e, l))).then((files) => {
        const child = (f: string): Promise<void> =>
          removeRecursive(sftp, path === '/' ? `/${f}` : `${path}/${f}`);
        return Promise.all(files.map((f) => child(f.filename))).then(() =>
          toPromise<void>((cb) => sftp.rmdir(path, (e) => cb(e ?? undefined, undefined))),
        );
      });
    }
    return toPromise<void>((cb) => sftp.unlink(path, (e) => cb(e ?? undefined, undefined)));
  });
}

function closeSession(s: SftpSession): void {
  if (s.closed) return;
  s.closed = true;
  for (const t of s.transfers.values()) {
    try {
      t.stream.destroy();
    } catch {
      /* already closed */
    }
  }
  s.transfers.clear();
  if (s.conn) {
    try {
      s.conn.end();
    } catch {
      /* already closed */
    }
    s.conn = null;
  }
}

function openConnection(ws: WebSocket, session: SftpSession, hostId: number, onDead: () => void): void {
  const database = getDb();
  const host = getHost(database, hostId);
  if (!host) {
    fail(ws, 'host not found');
    onDead();
    return;
  }
  const auth = buildAuthConfig(host);
  if (!auth.ok) {
    fail(ws, auth.error);
    addAudit(database, 'sftp.error', host.id, auth.error);
    onDead();
    return;
  }

  let rawKey: Buffer | null = null;
  const config: ConnectConfig = {
    host: host.host,
    port: host.port,
    username: host.username,
    readyTimeout: 15000,
    hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
      rawKey = key;
      verify(true);
    },
  };
  Object.assign(config, auth.config);

  const conn = new Client();
  session.conn = conn;

  conn.on('ready', () => {
    const fingerprint = hostKeyFingerprint(rawKey);
    if (fingerprint) {
      const known = getKnownHost(database, host.host, host.port);
      if (known && known.fingerprint !== fingerprint) {
        fail(ws, `host key mismatch: expected ${known.fingerprint} got ${fingerprint}`);
        addAudit(database, 'hostkey.mismatch', host.id, `${host.host}:${host.port} expected ${known.fingerprint} got ${fingerprint}`);
        conn.end();
        onDead();
        return;
      }
      if (!known) {
        upsertKnownHost(database, host.host, host.port, hostKeyAlg(rawKey ?? null), fingerprint);
        addAudit(database, 'hostkey.trusted', host.id, `${host.host}:${host.port} ${fingerprint}`);
      }
    }
    conn.sftp((err, sftp) => {
      if (err) {
        fail(ws, `sftp: ${String(err.message || err)}`);
        conn.end();
        onDead();
        return;
      }
      session.sftp = sftp;
      sftp.realpath('.', (e, cwd) => {
        if (e || !cwd) {
          session.cwd = '/';
        } else {
          session.cwd = cwd;
        }
        addAudit(database, 'sftp.connect', host.id, `${host.name} (${host.host}:${host.port}) cwd=${session.cwd}`);
        send(ws, { type: 'opened', cwd: session.cwd });
      });
    });
  });

  conn.on('error', (err: Error) => {
    const message = String(err.message || err);
    fail(ws, message);
    addAudit(database, 'sftp.error', host.id, message);
    onDead();
  });

  conn.on('close', () => onDead());

  conn.connect(config);
}

function handleList(ws: WebSocket, session: SftpSession, path: string): void {
  const sftp = session.sftp;
  if (!sftp) return fail(ws, 'not connected');
  sftp.readdir(path, (err, files) => {
    if (err) return fail(ws, `list: ${String(err.message || err)}`);
    const entries: SftpEntry[] = files
      .map((f) => entryFromAttrs(f.filename, path, f.attrs))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
    send(ws, { type: 'entries', path, entries });
  });
}

function startDownload(ws: WebSocket, session: SftpSession, id: string, path: string): void {
  const sftp = session.sftp;
  if (!sftp) return fail(ws, 'not connected', id);
  sftp.stat(path, (err, attrs) => {
    if (err || !attrs || !attrs.isFile()) {
      return fail(ws, `download: not a file: ${path}`, id);
    }
    const stream = sftp.createReadStream(path);
    const transfer: Transfer = { id, op: 'download', stream, name: path.split('/').pop() ?? path, transferred: 0, total: attrs.size ?? 0 };
    session.transfers.set(id, transfer);
    stream.on('data', (chunk: Buffer) => {
      transfer.transferred += chunk.length;
      send(ws, { type: 'data', id, data: encodeBase64(chunk) });
    });
    stream.on('end', () => {
      session.transfers.delete(id);
      const bytes = transfer.transferred;
      send(ws, { type: 'done', id, op: 'download', bytes });
      addAudit(getDb(), 'sftp.download', session.hostId, `${path} (${bytes} bytes)`);
    });
    stream.on('error', (e: Error) => {
      session.transfers.delete(id);
      fail(ws, `download: ${String(e.message || e)}`, id);
    });
    send(ws, { type: 'progress', id, transferred: 0, total: transfer.total });
  });
}

function startUpload(ws: WebSocket, session: SftpSession, id: string, path: string, size: number): void {
  const sftp = session.sftp;
  if (!sftp) return fail(ws, 'not connected', id);
  const stream = sftp.createWriteStream(path);
  const transfer: Transfer = { id, op: 'upload', stream, name: path.split('/').pop() ?? path, transferred: 0, total: size };
  session.transfers.set(id, transfer);
  // ssh2's WriteStream omits 'finish' under backpressure; 'close' is reliable post-end.
  stream.on('close', () => {
    if (!session.transfers.has(id) || transfer.cancelled) return; // cancelled or errored
    session.transfers.delete(id);
    const bytes = transfer.transferred;
    send(ws, { type: 'done', id, op: 'upload', bytes });
    addAudit(getDb(), 'sftp.upload', session.hostId, `${path} (${bytes} bytes)`);
  });
  stream.on('error', (e: Error) => {
    session.transfers.delete(id);
    fail(ws, `upload: ${String(e.message || e)}`, id);
  });
  send(ws, { type: 'progress', id, transferred: 0, total: size });
}

function cancelTransfer(ws: WebSocket, session: SftpSession, id: string): void {
  const transfer = session.transfers.get(id);
  if (!transfer) return;
  const onSettled = () => {
    if (!session.transfers.has(id)) return;
    session.transfers.delete(id);
    addAudit(getDb(), 'sftp.cancel', session.hostId, `${transfer.op} ${transfer.name} @ ${transfer.transferred}/${transfer.total}`);
    send(ws, { type: 'done', id, op: transfer.op, bytes: transfer.transferred });
  };
  transfer.stream.once('close', onSettled);
  transfer.stream.once('error', onSettled);
  try {
    // Upload: end() flushes buffered bytes so a partial file reliably lands on
    // disk (destroy() would drop unflushed data). Download: just stop reading.
    if (transfer.op === 'upload') (transfer.stream as Writable).end();
    else transfer.stream.destroy();
  } catch {
    onSettled();
  }
}

function handleClientMessage(ws: WebSocket, session: SftpSession, msg: SftpClientMessage, onDead: () => void): void {
  const sftp = session.sftp;
  switch (msg.type) {
    case 'open':
      if (session.conn) return;
      openConnection(ws, session, msg.hostId, onDead);
      break;
    case 'list':
      handleList(ws, session, msg.path);
      break;
    case 'stat':
      if (!sftp) return fail(ws, 'not connected');
      sftp.stat(msg.path, (err, attrs) => {
        if (err || !attrs) return fail(ws, `stat: ${String(err?.message || err)}`);
        send(ws, { type: 'entry', entry: entryFromAttrs(msg.path.split('/').pop() ?? msg.path, msg.path.slice(0, msg.path.lastIndexOf('/')) || '/', attrs) });
      });
      break;
    case 'mkdir':
      if (!sftp) return fail(ws, 'not connected');
      sftp.mkdir(msg.path, (err) => {
        if (err) return fail(ws, `mkdir: ${String(err.message || err)}`);
        addAudit(getDb(), 'sftp.mkdir', session.hostId, msg.path);
        send(ws, { type: 'ok', op: 'mkdir' });
      });
      break;
    case 'rename':
      if (!sftp) return fail(ws, 'not connected');
      sftp.rename(msg.from, msg.to, (err) => {
        if (err) return fail(ws, `rename: ${String(err.message || err)}`);
        addAudit(getDb(), 'sftp.rename', session.hostId, `${msg.from} -> ${msg.to}`);
        send(ws, { type: 'ok', op: 'rename' });
      });
      break;
    case 'remove':
      if (!sftp) return fail(ws, 'not connected');
      void removeRecursive(sftp, msg.path)
        .then(() => {
          addAudit(getDb(), 'sftp.remove', session.hostId, msg.path);
          send(ws, { type: 'ok', op: 'remove' });
        })
        .catch((e: Error) => fail(ws, `remove: ${String(e.message || e)}`));
      break;
    case 'chmod':
      if (!sftp) return fail(ws, 'not connected');
      sftp.chmod(msg.path, msg.mode, (err) => {
        if (err) return fail(ws, `chmod: ${String(err.message || err)}`);
        addAudit(getDb(), 'sftp.chmod', session.hostId, `${msg.path} ${msg.mode.toString(8)}`);
        send(ws, { type: 'ok', op: 'chmod' });
      });
      break;
    case 'chown':
      if (!sftp) return fail(ws, 'not connected');
      sftp.chown(msg.path, msg.uid, msg.gid, (err) => {
        if (err) return fail(ws, `chown: ${String(err.message || err)}`);
        addAudit(getDb(), 'sftp.chown', session.hostId, `${msg.path} ${msg.uid}:${msg.gid}`);
        send(ws, { type: 'ok', op: 'chown' });
      });
      break;
    case 'symlink':
      if (!sftp) return fail(ws, 'not connected');
      sftp.symlink(msg.target, msg.path, (err) => {
        if (err) return fail(ws, `symlink: ${String(err.message || err)}`);
        addAudit(getDb(), 'sftp.symlink', session.hostId, `${msg.path} -> ${msg.target}`);
        send(ws, { type: 'ok', op: 'symlink' });
      });
      break;
    case 'download-start':
      startDownload(ws, session, msg.id, msg.path);
      break;
    case 'upload-start':
      startUpload(ws, session, msg.id, msg.path, msg.size);
      break;
    case 'upload-chunk': {
      const transfer = session.transfers.get(msg.id);
      if (!transfer) return;
      const buf = Buffer.from(decodeBase64(msg.data));
      transfer.transferred += buf.length;
      (transfer.stream as Writable).write(buf);
      send(ws, { type: 'progress', id: msg.id, transferred: transfer.transferred, total: transfer.total });
      break;
    }
    case 'upload-end': {
      const transfer = session.transfers.get(msg.id);
      if (!transfer) return;
      (transfer.stream as Writable).end();
      break;
    }
    case 'cancel':
      cancelTransfer(ws, session, msg.id);
      break;
  }
}

export function registerSftpRoutes(app: FastifyInstance): void {
  app.get('/ws/sftp', { websocket: true }, (connection, _req: FastifyRequest) => {
    const socket: WebSocket = connection.socket;
    const session: SftpSession = { ws: socket, hostId: 0, conn: null, sftp: null, cwd: '/', transfers: new Map(), closed: false };

    const onDead = () => {
      if (session.closed) return;
      closeSession(session);
      socket.close();
    };

    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let msg: SftpClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as SftpClientMessage;
      } catch {
        return;
      }
      handleClientMessage(socket, session, msg, onDead);
    });

    socket.on('close', () => closeSession(session));
    socket.on('error', () => closeSession(session));
  });
}
