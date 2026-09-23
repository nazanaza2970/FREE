export const SFTP_PATH = '/ws/sftp';

export interface SftpEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
}

export type SftpClientMessage =
  | { type: 'open'; hostId: number }
  | { type: 'list'; path: string }
  | { type: 'stat'; path: string }
  | { type: 'mkdir'; path: string }
  | { type: 'rename'; from: string; to: string }
  | { type: 'remove'; path: string; recursive: boolean }
  | { type: 'chmod'; path: string; mode: number }
  | { type: 'chown'; path: string; uid: number; gid: number }
  | { type: 'symlink'; target: string; path: string }
  | { type: 'download-start'; id: string; path: string }
  | { type: 'upload-start'; id: string; path: string; size: number }
  | { type: 'upload-chunk'; id: string; data: string }
  | { type: 'upload-end'; id: string }
  | { type: 'cancel'; id: string };

export type SftpServerMessage =
  | { type: 'opened'; cwd: string }
  | { type: 'entries'; path: string; entries: SftpEntry[] }
  | { type: 'entry'; entry: SftpEntry }
  | { type: 'ok'; op: string }
  | { type: 'data'; id: string; data: string }
  | { type: 'progress'; id: string; transferred: number; total: number }
  | { type: 'done'; id: string; op: 'upload' | 'download'; bytes: number }
  | { type: 'error'; message: string; id?: string };
