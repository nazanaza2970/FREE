import ssh2 from 'ssh2';
import type Database from '../sqlite';
import { getDb, getKeyMaterial } from '../db';

const { AgentProtocol, BaseAgent, utils } = ssh2;
const { parseKey } = utils;
type ParsedKey = ssh2.ParsedKey;
type SignCallback = ssh2.SignCallback;
type SigningRequestOptions = ssh2.SigningRequestOptions;

/**
 * In-app ssh-agent: serves the private keys stored in the host table
 * (the application key store) over the standard SSH agent protocol,
 * so remote shells can authenticate to further hosts without touching
 * the OS agent.
 */
export class InAppAgent extends BaseAgent<ParsedKey> {
  constructor(private readonly database: Database.Database | null = null) {
    super();
  }

  private keys(): ParsedKey[] {
    const database = this.database ?? getDb();
    const out: ParsedKey[] = [];
    for (const material of getKeyMaterial(database)) {
      const parsed = parseKey(material.private_key, material.pass_phrase ?? undefined);
      if (!(parsed instanceof Error)) out.push(parsed);
    }
    return out;
  }

  getIdentities(cb: (err?: Error | null, keys?: ParsedKey[]) => void): void {
    try {
      cb(undefined, this.keys());
    } catch (e) {
      cb(e instanceof Error ? e : new Error(String(e)));
    }
  }

  sign(
    pubKey: ParsedKey | Buffer | string,
    data: Buffer,
    options: SigningRequestOptions | SignCallback,
    cb?: SignCallback,
  ): void {
    const done = typeof options === 'function' ? options : cb;
    if (!done) return;
    try {
      const want = parseKey(pubKey);
      if (want instanceof Error) {
        done(new Error('no matching private key in agent'));
        return;
      }
      for (const key of this.keys()) {
        if (key.type === want.type && key.getPublicSSH().equals(want.getPublicSSH())) {
          done(undefined, key.sign(data));
          return;
        }
      }
      done(new Error('no matching private key in agent'));
    } catch (e) {
      done(e instanceof Error ? e : new Error(String(e)));
    }
  }

  getStream(cb: (err: Error | undefined, stream?: InstanceType<typeof AgentProtocol>) => void): void {
    const proto = new AgentProtocol(false);
    proto.on('identities', (req) => {
      this.getIdentities((err, keys) => {
        if (err || !keys) proto.failureReply(req);
        else proto.getIdentitiesReply(req, keys);
      });
    });
    proto.on('sign', (req, pubKey, data, options) => {
      this.sign(pubKey, data, options, (err, sig) => {
        if (err || !sig) proto.failureReply(req);
        else proto.signReply(req, sig);
      });
    });
    cb(undefined, proto);
  }
}
