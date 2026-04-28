import { Router } from 'express';
import { safeReadJson, safeWriteJson, projectPath } from '../utils/fileHelpers.js';
import {
  listSeries, createSeries, getSeries, deleteSeries,
  linkEpisode, unlinkEpisode,
} from '../services/seriesManager.js';

const router = Router();

// GET /api/series
router.get('/', async (_req, res, next) => {
  try { res.json(await listSeries()); } catch (err) { next(err); }
});

// POST /api/series  { name }
router.post('/', async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });
    res.status(201).json(await createSeries(name.trim()));
  } catch (err) { next(err); }
});

// GET /api/series/:id
router.get('/:id', async (req, res, next) => {
  try {
    const s = await getSeries(req.params.id);
    if (!s) return res.status(404).json({ error: 'Series not found' });
    res.json(s);
  } catch (err) { next(err); }
});

// DELETE /api/series/:id
router.delete('/:id', async (req, res, next) => {
  try { await deleteSeries(req.params.id); res.json({ ok: true }); } catch (err) { next(err); }
});

// POST /api/series/:id/episodes  { projectId, episodeNumber? }
router.post('/:id/episodes', async (req, res, next) => {
  try {
    const { projectId, episodeNumber } = req.body;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });

    const series = await linkEpisode(req.params.id, projectId, episodeNumber);

    // Patch project.json with seriesId + episodeNumber
    const ep = series.episodes.find(e => e.projectId === projectId);
    const project = await safeReadJson(projectPath(projectId, 'project.json'), {});
    project.seriesId = req.params.id;
    project.seriesName = series.name;
    project.episodeNumber = ep.episode;
    await safeWriteJson(projectPath(projectId, 'project.json'), project);

    res.json(series);
  } catch (err) { next(err); }
});

// DELETE /api/series/:id/episodes/:projectId
router.delete('/:id/episodes/:projectId', async (req, res, next) => {
  try {
    await unlinkEpisode(req.params.id, req.params.projectId);

    // Remove series info from project.json
    const project = await safeReadJson(projectPath(req.params.projectId, 'project.json'), {});
    delete project.seriesId;
    delete project.seriesName;
    delete project.episodeNumber;
    await safeWriteJson(projectPath(req.params.projectId, 'project.json'), project);

    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
