import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_PATH = path.resolve(__dirname, '..', '..', 'youtube-credentials.json');
const TOKEN_PATH = path.resolve(__dirname, '..', '..', 'data', 'youtube-token.json');
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube'];

async function getOAuthClient() {
  const raw = await fs.readFile(CREDENTIALS_PATH, 'utf-8');
  const { installed } = JSON.parse(raw);
  return new google.auth.OAuth2(installed.client_id, installed.client_secret, 'http://localhost');
}

export async function getAuthUrl() {
  const client = await getOAuthClient();
  return client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
}

export async function exchangeCode(code) {
  const client = await getOAuthClient();
  const { tokens } = await client.getToken(code);
  await fs.mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf-8');
  logger.info('[YouTube] OAuth token saved');
  return tokens;
}

export async function isAuthenticated() {
  try {
    await fs.access(TOKEN_PATH);
    return true;
  } catch {
    return false;
  }
}

async function getAuthenticatedClient() {
  const client = await getOAuthClient();
  const raw = await fs.readFile(TOKEN_PATH, 'utf-8');
  client.setCredentials(JSON.parse(raw));
  // Auto-refresh if needed
  client.on('tokens', async (tokens) => {
    const existing = JSON.parse(await fs.readFile(TOKEN_PATH, 'utf-8'));
    await fs.writeFile(TOKEN_PATH, JSON.stringify({ ...existing, ...tokens }, null, 2), 'utf-8');
  });
  return client;
}

/**
 * Upload a video to YouTube.
 * @param {object} opts
 * @param {string} opts.videoPath   - absolute path to the mp4
 * @param {string} opts.title       - video title
 * @param {string} opts.description - video description
 * @param {string[]} opts.tags      - array of tags
 * @param {string} [opts.thumbPath] - optional thumbnail image path
 * @param {string} [opts.privacy]   - 'public' | 'private' | 'unlisted' (default: 'private')
 * @param {function} [opts.onProgress]
 */
export async function uploadVideo({ videoPath, title, description, tags = [], thumbPath, privacy = 'private', onProgress = () => {} }) {
  const auth = await getAuthenticatedClient();
  const youtube = google.youtube({ version: 'v3', auth });

  logger.info(`[YouTube] Uploading: ${title}`);
  onProgress('Uploading to YouTube...', 10);

  const stat = await fs.stat(videoPath);
  let uploaded = 0;

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description,
        tags,
        categoryId: '24', // Entertainment
        defaultLanguage: 'en',
      },
      status: {
        privacyStatus: privacy,
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      mimeType: 'video/mp4',
      body: createReadStream(videoPath).on('data', (chunk) => {
        uploaded += chunk.length;
        const pct = Math.round((uploaded / stat.size) * 80) + 10;
        onProgress(`Uploading... ${Math.round((uploaded / stat.size) * 100)}%`, pct);
      }),
    },
  });

  const videoId = res.data.id;
  logger.info(`[YouTube] Uploaded: https://youtu.be/${videoId}`);

  // Upload thumbnail if provided
  if (thumbPath) {
    onProgress('Setting thumbnail...', 92);
    try {
      await youtube.thumbnails.set({
        videoId,
        media: {
          mimeType: 'image/jpeg',
          body: createReadStream(thumbPath),
        },
      });
      logger.info('[YouTube] Thumbnail set');
    } catch (err) {
      logger.warn(`[YouTube] Thumbnail failed (channel may need verification): ${err.message}`);
    }
  }

  onProgress('Upload complete!', 100);
  return { videoId, url: `https://youtu.be/${videoId}` };
}
