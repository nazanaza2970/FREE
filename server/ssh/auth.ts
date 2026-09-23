import type { ConnectConfig } from 'ssh2';
import type { Host } from '../../shared/types';

export type AuthConfig = Pick<ConnectConfig, 'password' | 'privateKey' | 'passphrase'>;

export type AuthResult = { ok: true; config: AuthConfig } | { ok: false; error: string };

export function buildAuthConfig(host: Host): AuthResult {
  if (host.auth_method === 'key') {
    if (!host.private_key) {
      return { ok: false, error: 'no private key configured for host' };
    }
    return {
      ok: true,
      config: {
        privateKey: host.private_key,
        passphrase: host.pass_phrase || undefined,
      },
    };
  }
  if (!host.password) {
    return { ok: false, error: 'no credentials configured for host' };
  }
  return { ok: true, config: { password: host.password } };
}
