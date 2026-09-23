import ssh2 from 'ssh2';
import { hostKeyFingerprint } from './known_hosts';

const { utils } = ssh2;

export type GeneratedKeyType = 'ed25519' | 'rsa';

export interface GeneratedKey {
  type: GeneratedKeyType;
  private: string;
  public: string;
  fingerprint: string;
}

export function generateKeyPair(
  type: GeneratedKeyType = 'ed25519',
  bits = 3072,
  comment?: string,
): GeneratedKey {
  const pair: { private: string; public: string } =
    type === 'rsa'
      ? utils.generateKeyPairSync('rsa', { bits, comment })
      : utils.generateKeyPairSync('ed25519', { comment });
  const parsed = utils.parseKey(pair.public);
  if (parsed instanceof Error) throw parsed;
  const fingerprint = hostKeyFingerprint(parsed.getPublicSSH());
  return { type, private: pair.private, public: pair.public, fingerprint: fingerprint ?? 'SHA256:unknown' };
}
