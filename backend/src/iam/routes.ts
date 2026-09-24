import type { FastifyInstance } from 'fastify';
import type { Db } from '../platform/database.js';
import { sendJson } from '../platform/problems.js';
import { profile } from './accounts.js';
import { requireCaller } from './authentication.js';

export function registerIamRoutes(app: FastifyInstance, db: Db): void {
  app.get('/v1/me', async (request, reply) => sendJson(reply, 200, await profile(db, requireCaller(request).account)));
}
