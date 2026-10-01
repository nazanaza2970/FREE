import { useCallback, useEffect, useRef, useState } from 'react';
import type { Host } from '@shared/types';
import type { SftpClientMessage, SftpEntry, SftpServerMessage } from '@shared/sftp';
import { SFTP_PATH } from '@shared/sftp';
import { getApiToken } from '../api';
import { decodeBase64 } from '@shared/protocol';

const CHUNK = 256 * 1024;

interface TransferState {
  id: string;
  op: 'upload' | 'download';
  name: string;
  transferred: number;
  total: number;
}

interface Props {
  host: Host;
}

function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtTime(sec: number): string {
  return sec > 0 ? new Date(sec * 1000).toLocaleString() : '—';
}

export default function SftpBrowser({ host }: Props) {
  const [status, setStatus] = useState<'connecting' | 'open' | 'error'>('connecting');
  const [cwd, setCwd] = useState('~');
  const [entries, setEntries] = useState<SftpEntry[] | null>(null);
  const [localFiles, setLocalFiles] = useState<File[]>([]);
  const [transfers, setTransfers] = useState<TransferState[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const downloadsRef = useRef(new Map<string, { chunks: Uint8Array[]; name: string }>());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const send = useCallback((msg: SftpClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const list = useCallback(
    (path: string) => {
      setEntries(null);
      send({ type: 'list', path });
    },
    [send],
  );

  const connect = useCallback(() => {
    setStatus('connecting');
    setEntries(null);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = getApiToken();
    const ws = new WebSocket(`${proto}://${location.host}${SFTP_PATH}${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('open');
      send({ type: 'open', hostId: host.id });
    };
    ws.onclose = () => {
      if (wsRef.current === ws) setStatus('error');
    };
    ws.onerror = () => {
      if (wsRef.current === ws) setStatus('error');
    };
    ws.onmessage = (ev) => {
      let msg: SftpServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as SftpServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'opened':
          setCwd(msg.cwd);
          list(msg.cwd);
          break;
        case 'entries':
          setCwd(msg.path);
          setEntries(msg.entries);
          break;
        case 'ok':
          setMessage(`${msg.op} ok`);
          list(cwd);
          break;
        case 'entry':
          break;
        case 'progress':
          setTransfers((prev) => prev.map((t) => (t.id === msg.id ? { ...t, transferred: msg.transferred, total: msg.total } : t)));
          break;
        case 'data': {
          const rec = downloadsRef.current.get(msg.id);
          if (rec) rec.chunks.push(decodeBase64(msg.data));
          break;
        }
        case 'done': {
          setTransfers((prev) => prev.filter((t) => t.id !== msg.id));
          if (msg.op === 'download') {
            const rec = downloadsRef.current.get(msg.id);
            downloadsRef.current.delete(msg.id);
            if (rec) {
              const blob = new Blob(rec.chunks as BlobPart[]);
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = rec.name;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 5000);
            }
            list(cwd);
          } else {
            list(cwd);
          }
          break;
        }
        case 'error':
          setMessage(msg.message);
          setTransfers((prev) => prev.filter((t) => t.id !== msg.id));
          break;
      }
    };
  }, [host.id, list, send]);

  useEffect(() => {
    connect();
    return () => {
      const ws = wsRef.current;
      if (ws) wsRef.current = null;
      ws?.close();
    };
  }, [connect]);

  const cd = (path: string) => list(path);

  const parentPath = (p: string): string | null => {
    if (p === '/') return null;
    const idx = p.lastIndexOf('/');
    if (idx <= 0) return '/';
    return p.slice(0, idx);
  };

  const doMkdir = () => {
    const name = window.prompt('New folder name');
    if (!name || !name.trim()) return;
    send({ type: 'mkdir', path: joinPath(cwd, name.trim()) });
  };

  const doRename = (entry: SftpEntry) => {
    const name = window.prompt('Rename to (new name in same directory)', entry.name);
    if (!name || !name.trim() || name.trim() === entry.name) return;
    send({ type: 'rename', from: entry.path, to: joinPath(cwd, name.trim()) });
  };

  const doRemove = (entry: SftpEntry) => {
    const what = entry.type === 'directory' ? 'folder (and its contents)' : 'file';
    if (!window.confirm(`Delete ${what} "${entry.name}"?`)) return;
    send({ type: 'remove', path: entry.path, recursive: entry.type === 'directory' });
  };

  const doChmod = (entry: SftpEntry) => {
    const v = window.prompt(`Mode for "${entry.name}" (octal, e.g. 755)`, (entry.mode & 0o777).toString(8));
    if (!v) return;
    const mode = Number.parseInt(v.trim(), 8);
    if (Number.isNaN(mode)) return setMessage('chmod: expected an octal mode like 755');
    send({ type: 'chmod', path: entry.path, mode });
  };

  const doChown = (entry: SftpEntry) => {
    const v = window.prompt(`Owner for "${entry.name}" as uid:gid`, `${entry.uid}:${entry.gid}`);
    if (!v) return;
    const [u, g] = v.trim().split(':').map((x) => Number.parseInt(x, 10));
    if (Number.isNaN(u) || Number.isNaN(g)) return setMessage('chown: expected uid:gid, e.g. 1000:1000');
    send({ type: 'chown', path: entry.path, uid: u, gid: g });
  };

  const doSymlink = () => {
    const target = window.prompt('Symlink target (existing path)');
    if (!target || !target.trim()) return;
    const name = window.prompt('Symlink name (in current directory)');
    if (!name || !name.trim()) return;
    send({ type: 'symlink', target: target.trim(), path: joinPath(cwd, name.trim()) });
  };

  const doDownload = (entry: SftpEntry) => {
    const id = crypto.randomUUID();
    downloadsRef.current.set(id, { chunks: [], name: entry.name });
    setTransfers((prev) => [...prev, { id, op: 'download', name: entry.name, transferred: 0, total: entry.size }]);
    send({ type: 'download-start', id, path: entry.path });
  };

  const uploadOne = async (file: File) => {
    const id = crypto.randomUUID();
    const dest = joinPath(cwd, file.name);
    setTransfers((prev) => [...prev, { id, op: 'upload', name: file.name, transferred: 0, total: file.size }]);
    send({ type: 'upload-start', id, path: dest, size: file.size });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      for (let off = 0; off < bytes.length; off += CHUNK) {
        if (wsRef.current?.readyState !== WebSocket.OPEN) throw new Error('connection closed during upload');
        send({ type: 'upload-chunk', id, data: toB64(bytes.subarray(off, off + CHUNK)) });
      }
      send({ type: 'upload-end', id });
    } catch (e) {
      send({ type: 'cancel', id });
      setMessage(String(e instanceof Error ? e.message : e));
    }
  };

  const uploadSelected = (files: File[]) => {
    for (const f of files) void uploadOne(f);
  };

  const cancelTransfer = (id: string) => {
    downloadsRef.current.delete(id);
    send({ type: 'cancel', id });
  };

  const segments = cwd === '/' ? [] : cwd.split('/').filter(Boolean);

  return (
    <div className="sftp">
      <div className="sftp-pane sftp-local">
        <div className="sftp-pane-head">
          <span>Local files</span>
          <button className="ghost" onClick={() => fileInputRef.current?.click()}>
            + Add files
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              setLocalFiles((prev) => [...prev, ...files]);
              uploadSelected(files);
              e.target.value = '';
            }}
          />
        </div>
        {localFiles.length === 0 ? (
          <div className="empty">Pick local files to upload them to the remote host.</div>
        ) : (
          localFiles.map((f, i) => (
            <div key={`${f.name}-${i}`} className="local-row">
              <span className="lname" title={f.name}>
                {f.name}
              </span>
              <span className="dim">{fmtSize(f.size)}</span>
              <button className="ghost" title={`Upload to ${cwd}`} onClick={() => void uploadOne(f)}>
                ⬆
              </button>
              <button className="ghost" onClick={() => setLocalFiles((prev) => prev.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      <div className="sftp-pane sftp-remote">
        <div className="sftp-toolbar">
          <div className="sftp-crumbs">
            <button className="ghost" disabled={cwd === '/'} onClick={() => {
              const p = parentPath(cwd);
              if (p) cd(p);
            }}>
              ↑
            </button>
            <button className="crumb" onClick={() => cd('/')}>/</button>
            {segments.map((s, i) => (
              <span key={i}>
                <button className="crumb" onClick={() => cd('/' + segments.slice(0, i + 1).join('/'))}>
                  {s}
                </button>
                /
              </span>
            ))}
          </div>
          <div className="sftp-actions">
            <button className="ghost" disabled={status !== 'open'} onClick={() => list(cwd)} title="Refresh">
              ⟳
            </button>
            <button className="ghost" disabled={status !== 'open'} onClick={doMkdir} title="New folder">
              🗀
            </button>
            <button className="ghost" disabled={status !== 'open'} onClick={doSymlink} title="New symlink">
              ⌁
            </button>
          </div>
        </div>

        {status === 'connecting' ? (
          <div className="empty">Connecting SFTP to {host.name}…</div>
        ) : status === 'error' ? (
          <div className="empty">
            <p>SFTP connection problem.</p>
            <button className="primary" onClick={connect}>
              Reconnect
            </button>
          </div>
        ) : entries === null ? (
          <div className="empty">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="empty">Empty directory.</div>
        ) : (
          <div className="sftp-table-wrap">
            <table className="sftp-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Size</th>
                  <th className="num">Mode</th>
                  <th className="num">Owner</th>
                  <th>Modified</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr
                    key={e.path}
                    onDoubleClick={() => {
                      if (e.type === 'directory') cd(e.path);
                    }}
                  >
                    <td>
                      <span className={`ficon ${e.type}`}>{e.type === 'directory' ? '🗀' : e.type === 'symlink' ? '⌁' : e.type === 'file' ? '🗎' : '?'}</span>
                      <span
                        className={e.type === 'directory' ? 'fname link' : 'fname'}
                        onClick={() => {
                          if (e.type === 'directory') cd(e.path);
                        }}
                        title={e.path}
                      >
                        {e.name}
                      </span>
                    </td>
                    <td className="num dim">{e.type === 'file' ? fmtSize(e.size) : '—'}</td>
                    <td className="num dim">{(e.mode & 0o777).toString(8).padStart(3, '0')}</td>
                    <td className="num dim">
                      {e.uid}:{e.gid}
                    </td>
                    <td className="dim">{fmtTime(e.mtime)}</td>
                    <td className="row-actions">
                      {e.type === 'file' && (
                        <button className="ghost" title="Download" onClick={() => doDownload(e)}>
                          ⬇
                        </button>
                      )}
                      <button className="ghost" title="Rename" onClick={() => doRename(e)}>
                        ✎
                      </button>
                      <button className="ghost" title="chmod" onClick={() => doChmod(e)}>
                        #
                      </button>
                      <button className="ghost" title="chown" onClick={() => doChown(e)}>
                        @
                      </button>
                      <button className="ghost" title="Delete" onClick={() => doRemove(e)}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(transfers.length > 0 || message) && (
        <div className="sftp-footer">
          {message && (
            <div className="sftp-msg" onClick={() => setMessage(null)} title="Click to dismiss">
              {message}
            </div>
          )}
          {transfers.map((t) => {
            const pct = t.total > 0 ? Math.min(100, Math.round((t.transferred / t.total) * 100)) : 0;
            return (
              <div key={t.id} className="sftp-transfer">
                <span className="tname" title={t.name}>
                  {t.op === 'upload' ? '⬆' : '⬇'} {t.name}
                </span>
                <div className="tbar">
                  <div className="tfill" style={{ width: `${pct}%` }} />
                </div>
                <span className="tpct">
                  {fmtSize(t.transferred)}/{fmtSize(t.total)} ({pct}%)
                </span>
                <button className="ghost" onClick={() => cancelTransfer(t.id)}>
                  Cancel
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
