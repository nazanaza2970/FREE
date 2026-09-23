import type { FastifyInstance } from 'fastify';
import { generateKeyPair, type GeneratedKeyType } from '../ssh/keys';

export async function keyRoutes(app: FastifyInstance): Promise<void> {
  app.post('/generate', async (req, reply) => {
    const body = (req.body ?? {}) as { type?: string; bits?: number; comment?: string };
    const type: GeneratedKeyType = body.type === 'rsa' ? 'rsa' : 'ed25519';
    const bits = type === 'rsa' ? Math.min(Math.max(Number(body.bits) || 3072, 2048), 16384) : 3072;
    try {
      return generateKeyPair(type, bits, body.comment);
    } catch (e) {
      return reply.code(400).send({ error: String(e instanceof Error ? e.message : e) });
    }
  });
}
