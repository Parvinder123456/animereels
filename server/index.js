import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') });
import express from 'express';
import cors from 'cors';
import path from 'path';

import settingsRouter from './routes/settings.js';
import youtubeRouter from './routes/youtube.js';
import seriesRouter from './routes/series.js';
import projectsRouter from './routes/projects.js';
import uploadRouter from './routes/upload.js';
import panelsRouter from './routes/panels.js';
import scriptRouter from './routes/script.js';
import voiceRouter from './routes/voice.js';
import renderRouter from './routes/render.js';
import eventsRouter from './routes/events.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './utils/logger.js';
import { detectNvenc } from './services/gpuDetect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const app = express();
const PORT = process.env.PORT || 3001;

const isProd = process.env.NODE_ENV === 'production';

// Middleware
if (!isProd) {
  app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }));
}
app.use(express.json({ limit: '50mb' }));

// Static files: serve project data
app.use('/data', express.static(path.join(ROOT_DIR, 'data', 'projects')));

// API routes
app.use('/api/settings', settingsRouter);
app.use('/api/events', eventsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/projects', uploadRouter);
app.use('/api/projects', panelsRouter);
app.use('/api/projects', scriptRouter);
app.use('/api/projects', voiceRouter);
app.use('/api/projects', renderRouter);

app.use('/api/youtube', youtubeRouter);
app.use('/api/series', seriesRouter);

// Serve built React app in production
if (isProd) {
  const clientDist = path.join(ROOT_DIR, 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// Error handler
app.use(errorHandler);

// Detect GPU encoding support at startup (cached for all future renders)
detectNvenc();

app.listen(PORT, () => {
  logger.info(`AnimeReels server running on http://localhost:${PORT}`);
});

export default app;
