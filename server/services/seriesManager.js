import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'data', 'series'
);
const INDEX_FILE = path.join(DATA_DIR, '_index.json');

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readIndex() {
  try {
    return JSON.parse(await fs.readFile(INDEX_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

async function writeIndex(index) {
  await ensureDir();
  await fs.writeFile(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
}

async function readSeries(id) {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, `${id}.json`), 'utf-8'));
  } catch {
    return null;
  }
}

async function writeSeries(series) {
  await ensureDir();
  await fs.writeFile(path.join(DATA_DIR, `${series.id}.json`), JSON.stringify(series, null, 2), 'utf-8');
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function listSeries() {
  const index = await readIndex();
  const full = await Promise.all(index.map(entry => readSeries(entry.id)));
  return full.filter(Boolean);
}

export async function createSeries(name) {
  const id = `series_${uuidv4().split('-')[0]}`;
  const series = {
    id,
    name,
    episodes: [],
    storySummary: '',
    createdAt: new Date().toISOString(),
  };
  await writeSeries(series);
  const index = await readIndex();
  index.push({ id, name, createdAt: series.createdAt });
  await writeIndex(index);
  return series;
}

export async function getSeries(id) {
  return readSeries(id);
}

export async function deleteSeries(id) {
  const index = (await readIndex()).filter(s => s.id !== id);
  await writeIndex(index);
  try { await fs.unlink(path.join(DATA_DIR, `${id}.json`)); } catch {}
}

/**
 * Link a project to a series as an episode.
 * If episodeNumber is omitted, appends as the next episode.
 */
export async function linkEpisode(seriesId, projectId, episodeNumber) {
  const series = await readSeries(seriesId);
  if (!series) throw new Error(`Series ${seriesId} not found`);

  // Remove any existing entry for this project
  series.episodes = series.episodes.filter(e => e.projectId !== projectId);

  const num = episodeNumber ?? (series.episodes.length + 1);
  series.episodes.push({ projectId, episode: num, linkedAt: new Date().toISOString() });
  series.episodes.sort((a, b) => a.episode - b.episode);

  await writeSeries(series);
  return series;
}

export async function unlinkEpisode(seriesId, projectId) {
  const series = await readSeries(seriesId);
  if (!series) return;
  series.episodes = series.episodes.filter(e => e.projectId !== projectId);
  await writeSeries(series);
}

/**
 * Get the story summary from all previous episodes before the given projectId.
 * Returns '' if this is the first episode or no summary exists yet.
 */
export async function getPreviousStorySummary(seriesId, projectId) {
  const series = await readSeries(seriesId);
  if (!series || !series.storySummary) return '';

  // Find this episode's number
  const thisEp = series.episodes.find(e => e.projectId === projectId);
  if (!thisEp || thisEp.episode <= 1) return '';

  return series.storySummary;
}

/**
 * Save updated story summary after an episode completes.
 */
export async function updateStorySummary(seriesId, newSummary) {
  const series = await readSeries(seriesId);
  if (!series) return;
  series.storySummary = newSummary;
  series.updatedAt = new Date().toISOString();
  await writeSeries(series);

  // Update index name cache
  const index = await readIndex();
  const entry = index.find(s => s.id === seriesId);
  if (entry) {
    entry.updatedAt = series.updatedAt;
    await writeIndex(index);
  }
}
