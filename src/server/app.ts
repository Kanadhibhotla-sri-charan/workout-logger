import express, { type Express } from 'express';
import type Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { blueprintRouter } from './routes/blueprint.js';
import { goalsRouter } from './routes/goals.js';
import { programsRouter } from './routes/programs.js';
import { workoutsRouter } from './routes/workouts.js';
import { exportRouter } from './routes/export.js';
import { trainingProfileRouter } from './routes/trainingProfile.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', '..', 'public');

export function createApp(db: Database.Database): Express {
  const app = express();
  app.locals.db = db;

  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  app.use('/api/blueprint', blueprintRouter);
  app.use('/api/goals', goalsRouter);
  app.use('/api/programs', programsRouter);
  app.use('/api/workouts', workoutsRouter);
  app.use('/api/export', exportRouter);
  app.use('/api/training-profile', trainingProfileRouter);

  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
