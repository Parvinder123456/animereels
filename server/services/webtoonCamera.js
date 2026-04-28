/**
 * webtoonCamera.js
 *
 * Camera system for manhwa/webtoon vertical strips.
 * Scrolls top-to-bottom with AI-directed interest points instead of panel cuts.
 */

import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'fs/promises';
import path from 'path';
import { visionQuery } from '../utils/visionClient.js';
import { retry } from '../utils/retry.js';
import { getFfmpegPath } from './gpuDetect.js';
import { logger } from '../utils/logger.js';

const FPS = 25;
// FULL-WIDTH zoom levels: at zoom=1.0 on a 1200px-wide input with 1080px output,
// the entire image width is visible. Only zoom >1.0 for subtle face emphasis.
// tight: slight zoom on faces. medium: barely zoomed. wide: full width no crop.
const ZOOM_LEVELS = { tight: 1.25, medium: 1.1, wide: 1.0 };

// ─── 1. AI Strip Analysis ────────────────────────────────────────────────────

const WEBTOON_PROMPT = `You are analyzing a manhwa/webtoon vertical strip for a cinematic recap video.
The camera will scroll from top to bottom showing the FULL WIDTH of the image.
Identify 4-7 key interest points where the camera should PAUSE during the scroll.

For each point return:
- y_center: vertical center as fraction of image height (0.0=top, 1.0=bottom), in top-to-bottom order
- x_center: always 0.5 (camera shows full width, no horizontal panning)
- importance: 1-5 (5=character face close-up, 4=action impact, 3=important scene, 2=transition, 1=background)
- type: "face"|"action"|"scene"|"transition"
- zoom: "tight" for faces only, "wide" for everything else
- label: brief description

CRITICAL RULES:
- ONLY mark character FACES and ACTION IMPACTS as importance 4-5
- Do NOT mark dialogue bubbles, text boxes, or speech as interest points
- Do NOT mark scenery or backgrounds unless they contain a character
- The camera shows the full image width — we only need to know WHERE to pause vertically
- Points MUST be sorted by y_center ascending (top to bottom)
- Must cover from near top (y_center≤0.15) to near bottom (y_center≥0.85)
- Skip title cards, chapter headers, credits, and decorative text entirely

Return ONLY valid JSON array, no markdown:
[
  { "y_center": 0.1, "x_center": 0.5, "importance": 5, "type": "face", "zoom": "tight", "label": "character angry expression" },
  { "y_center": 0.6, "x_center": 0.5, "importance": 4, "type": "action", "zoom": "wide", "label": "sword clash impact" }
]`;

/**
 * Analyze a webtoon strip with Gemini Vision and return interest points.
 * @param {string} imagePath
 * @returns {Array} interest points: [{ y_center, x_center, importance, type, zoom, label }]
 */
export async function analyzeWebtoonStrip(imagePath) {
  const fileName = path.basename(imagePath);
  logger.info(`[analyzeWebtoonStrip] START — ${fileName}`);

  let stat;
  try {
    stat = await fs.stat(imagePath);
    logger.info(`[analyzeWebtoonStrip] Image size: ${(stat.size / 1024).toFixed(1)} KB`);
  } catch (e) {
    logger.warn(`[analyzeWebtoonStrip] Could not stat image: ${e.message}`);
  }

  const imgBuffer = await fs.readFile(imagePath);
  const mimeType = imagePath.endsWith('.png') ? 'image/png'
    : imagePath.endsWith('.webp') ? 'image/webp'
      : 'image/jpeg';
  logger.info(`[analyzeWebtoonStrip] Sending to Gemini Vision — mimeType: ${mimeType}, buffer: ${imgBuffer.length} bytes`);

  let raw;
  try {
    raw = await retry(async () => {
      return visionQuery(WEBTOON_PROMPT, imgBuffer, mimeType);
    }, { maxAttempts: 2, label: `webtoon-${fileName}` });
    logger.info(`[analyzeWebtoonStrip] Gemini response received — ${raw?.length ?? 0} chars`);
    logger.info(`[analyzeWebtoonStrip] Raw response: ${raw?.slice(0, 400)}`);
  } catch (err) {
    logger.error(`[analyzeWebtoonStrip] Gemini call failed: ${err.message}`);
    throw err;
  }

  const points = parseInterestPoints(raw, fileName);
  if (points) {
    logger.info(`[analyzeWebtoonStrip] Parsed ${points.length} interest point(s):`);
    points.forEach((p, i) =>
      logger.info(`[analyzeWebtoonStrip]   [${i}] y=${p.y_center.toFixed(3)} x=${p.x_center.toFixed(3)} importance=${p.importance} type=${p.type} zoom=${p.zoom} label="${p.label}"`)
    );
  } else {
    logger.warn(`[analyzeWebtoonStrip] Parsing returned null — will use fallback scroll`);
  }

  return points;
}

function parseInterestPoints(raw, fileName) {
  logger.info(`[parseInterestPoints] Parsing Gemini response for ${fileName}`);
  try {
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : (arrayMatch ? arrayMatch[0] : null);
    if (!jsonStr) throw new Error('No JSON array found in response');

    logger.info(`[parseInterestPoints] Found JSON string (${jsonStr.length} chars)`);
    const arr = JSON.parse(jsonStr);
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('Parsed array is empty');
    logger.info(`[parseInterestPoints] Raw array has ${arr.length} item(s) before validation`);

    const validated = arr
      .filter(p =>
        typeof p.y_center === 'number' &&
        typeof p.x_center === 'number' &&
        typeof p.importance === 'number'
      )
      .map(p => ({
        y_center:   Math.max(0, Math.min(1, p.y_center)),
        x_center:   Math.max(0.1, Math.min(0.9, p.x_center)),
        importance: Math.max(1, Math.min(5, Math.round(p.importance))),
        type:       String(p.type || 'other'),
        zoom:       ['tight', 'medium', 'wide'].includes(p.zoom) ? p.zoom : 'medium',
        label:      String(p.label || '').slice(0, 80),
      }))
      .sort((a, b) => a.y_center - b.y_center)
      .slice(0, 7);

    if (validated.length === 0) throw new Error('No valid points after filtering');
    logger.info(`[parseInterestPoints] Validated ${validated.length} point(s) for ${fileName}`);
    return validated;
  } catch (err) {
    logger.warn(`[parseInterestPoints] FAILED for ${fileName}: ${err.message}`);
    return null;
  }
}

// ─── 2. Scroll Path Planner ──────────────────────────────────────────────────

/**
 * Build a scroll path (keyframe array) from interest points.
 * @param {Array|null} interestPoints
 * @param {number} duration  seconds
 * @returns {Array} keyframes: [{ frame, y, x, zoom }]
 */
export function buildScrollPath(interestPoints, duration) {
  const totalFrames = Math.max(2, Math.round(duration * FPS));
  logger.info(`[buildScrollPath] duration=${duration.toFixed(2)}s, totalFrames=${totalFrames}, interestPoints=${interestPoints?.length ?? 0}`);

  if (!interestPoints || interestPoints.length === 0) {
    logger.warn(`[buildScrollPath] No interest points — using default top→bottom scroll`);
    return defaultScrollPath(totalFrames);
  }

  if (duration < 2) {
    const top = interestPoints.reduce((a, b) => b.importance > a.importance ? b : a);
    logger.info(`[buildScrollPath] Short clip (<2s) — single keyframe on most important point: "${top.label}" y=${top.y_center.toFixed(3)}`);
    return [{ frame: 0, y: top.y_center, x: 0.5, zoom: ZOOM_LEVELS[top.zoom] || 2.2 }];
  }

  // Step 1: Sort by y_center
  const sorted = [...interestPoints].sort((a, b) => a.y_center - b.y_center);
  logger.info(`[buildScrollPath] Interest points sorted by y_center (raw):`);
  sorted.forEach((p, i) =>
    logger.info(`[buildScrollPath]   [${i}] y=${p.y_center.toFixed(3)} x=${p.x_center.toFixed(3)} imp=${p.importance} zoom=${p.zoom} "${p.label}"`)
  );

  // Step 2: Deduplicate points within 0.08 y distance — prevents stutter from
  // Gemini placing multiple dialogue bubbles in a tight vertical cluster.
  const deduped = [];
  for (const pt of sorted) {
    const prev = deduped[deduped.length - 1];
    if (prev && (pt.y_center - prev.y_center) < 0.08) {
      if (pt.importance > prev.importance) {
        logger.info(`[buildScrollPath] Dedup: replacing y=${prev.y_center.toFixed(3)} imp=${prev.importance} with y=${pt.y_center.toFixed(3)} imp=${pt.importance} (higher importance within 0.08 gap)`);
        deduped[deduped.length - 1] = pt;
      } else {
        logger.info(`[buildScrollPath] Dedup: dropping y=${pt.y_center.toFixed(3)} imp=${pt.importance} (too close to y=${prev.y_center.toFixed(3)}, keeping higher imp=${prev.importance})`);
      }
    } else {
      deduped.push(pt);
    }
  }
  logger.info(`[buildScrollPath] After dedup: ${sorted.length} → ${deduped.length} points`);

  // Step 3: Inject waypoints for large vertical gaps (>0.3) to ensure full-strip coverage
  const withWaypoints = [];
  for (let i = 0; i < deduped.length; i++) {
    withWaypoints.push(deduped[i]);
    if (i < deduped.length - 1) {
      const gap = deduped[i + 1].y_center - deduped[i].y_center;
      if (gap > 0.3) {
        const wp = {
          y_center: deduped[i].y_center + gap / 2,
          x_center: 0.5,
          importance: 1,
          type: 'scenery',
          zoom: 'wide',
          label: 'transition waypoint',
        };
        logger.info(`[buildScrollPath] Gap of ${gap.toFixed(3)} between [${i}] and [${i+1}] — inserting waypoint at y=${wp.y_center.toFixed(3)}`);
        withWaypoints.push(wp);
      }
    }
  }
  logger.info(`[buildScrollPath] Total waypoints after gap-fill: ${withWaypoints.length}`);

  const n = withWaypoints.length;
  const dwellBudget = Math.round(totalFrames * 0.65);
  const scrollBudget = totalFrames - dwellBudget;
  const scrollPerTransition = n > 1 ? Math.round(scrollBudget / (n - 1)) : 0;
  const totalWeight = withWaypoints.reduce((sum, p) => sum + (0.5 + p.importance / 5), 0);

  logger.info(`[buildScrollPath] Budget — dwell: ${dwellBudget} frames (65%), scroll: ${scrollBudget} frames (35%), scrollPerTransition: ${scrollPerTransition} frames`);

  const keyframes = [];
  let currentFrame = 0;

  for (let i = 0; i < n; i++) {
    const pt = withWaypoints[i];
    const weight = 0.5 + pt.importance / 5;
    const dwellFrames = Math.max(2, Math.round((weight / totalWeight) * dwellBudget));

    // KEY: x is always locked to 0.5 (center).
    // Webtoon is a vertical-scroll format. Gemini's x_center values reflect where
    // dialogue bubbles sit on the page (alternating left/right), which creates
    // horizontal ping-pong if followed literally. Locking to center keeps the
    // camera scrolling smoothly downward — the correct motion for this format.
    // Zoom: use importance to drive depth, not the per-point "tight/medium/wide" label
    // (which causes jarring 3.2→1.8→3.2 pulsing). Range is now 1.8–2.8.
    const zoom = pt.importance >= 5 ? ZOOM_LEVELS.tight    // 2.8 — close-up faces
               : pt.importance >= 4 ? ZOOM_LEVELS.medium   // 2.2 — action/emotion
               :                      ZOOM_LEVELS.wide;    // 1.8 — dialogue/scenery

    const kf = {
      frame: currentFrame,
      y: pt.y_center,
      x: 0.5,   // always center — no horizontal panning
      zoom,
    };
    keyframes.push(kf);
    logger.info(`[buildScrollPath]   kf[${i}] frame=${currentFrame} y=${kf.y.toFixed(3)} x=0.500 (locked) zoom=${kf.zoom.toFixed(2)} dwell=${dwellFrames}f (${(dwellFrames/FPS).toFixed(2)}s) imp=${pt.importance} "${pt.label}"`);

    currentFrame += dwellFrames;
    if (i < n - 1 && scrollPerTransition > 0) {
      logger.info(`[buildScrollPath]   → scroll transition: ${scrollPerTransition} frames (${(scrollPerTransition/FPS).toFixed(2)}s)`);
      currentFrame += scrollPerTransition;
    }
  }

  logger.info(`[buildScrollPath] Built ${keyframes.length} keyframe(s), last frame=${keyframes[keyframes.length-1]?.frame}, totalFrames=${totalFrames}`);
  return keyframes;
}

function defaultScrollPath(totalFrames) {
  const mid = Math.round(totalFrames / 2);
  const kfs = [
    { frame: 0,              y: 0.12, x: 0.5, zoom: 1.0 },
    { frame: mid,            y: 0.50, x: 0.5, zoom: 1.05 },
    { frame: totalFrames - 1, y: 0.88, x: 0.5, zoom: 1.0 },
  ];
  logger.info(`[defaultScrollPath] 3 keyframes: top(0) → mid(${mid}) → bottom(${totalFrames-1})`);
  return kfs;
}

// ─── 3. FFmpeg Expression Generator ─────────────────────────────────────────

/**
 * Build piecewise zoompan z/x/y expressions from keyframes.
 * @param {Array} keyframes  [{ frame, y, x, zoom }]
 * @returns {{ z, x, y }} ffmpeg expression strings, or null on failure
 */
export function buildZoompanExpression(keyframes) {
  logger.info(`[buildZoompanExpression] Building piecewise expression for ${keyframes?.length ?? 0} keyframe(s)`);

  if (!keyframes || keyframes.length === 0) {
    logger.warn(`[buildZoompanExpression] No keyframes — returning null`);
    return null;
  }

  if (keyframes.length === 1) {
    const kf = keyframes[0];
    const z = kf.zoom.toFixed(4);
    logger.info(`[buildZoompanExpression] Single keyframe — constant z=${z} y=${kf.y.toFixed(4)} x=${kf.x.toFixed(4)}`);
    return {
      z,
      x: `max(0,min(${kf.x.toFixed(4)}*iw-iw/${z}/2,iw-iw/${z}))`,
      y: `max(0,min(${kf.y.toFixed(4)}*ih-ih/${z}/2,ih-ih/${z}))`,
    };
  }

  function buildPiecewise(valueFn, label) {
    const last = valueFn(keyframes.length - 1);
    let expr = last.toFixed(8);

    for (let i = keyframes.length - 2; i >= 0; i--) {
      const v0 = valueFn(i);
      const v1 = valueFn(i + 1);
      const f0 = keyframes[i].frame;
      const f1 = keyframes[i + 1].frame;
      const span = f1 - f0;

      if (span <= 0) {
        logger.warn(`[buildZoompanExpression] ${label}: zero span between kf[${i}] and kf[${i+1}], skipping segment`);
        continue;
      }

      let segExpr;
      if (Math.abs(v1 - v0) < 1e-9) {
        segExpr = v0.toFixed(8);
      } else {
        const slope = (v1 - v0) / span;
        segExpr = `(${v0.toFixed(8)}+${slope.toFixed(10)}*(on-${f0}))`;
      }
      expr = `if(lte(on,${f1}),${segExpr},${expr})`;
    }
    return `if(lt(on,${keyframes[0].frame + 1}),${valueFn(0).toFixed(8)},${expr})`;
  }

  const zExpr = buildPiecewise(i => keyframes[i].zoom, 'z');
  const yCenterExpr = buildPiecewise(i => keyframes[i].y, 'y');
  const xCenterExpr = buildPiecewise(i => keyframes[i].x, 'x');

  const yExpr = `max(0,min((${yCenterExpr})*ih-ih/(${zExpr})/2,ih-ih/(${zExpr})))`;
  const xExpr = `max(0,min((${xCenterExpr})*iw-iw/(${zExpr})/2,iw-iw/(${zExpr})))`;

  logger.info(`[buildZoompanExpression] z expression length: ${zExpr.length} chars`);
  logger.info(`[buildZoompanExpression] y expression length: ${yExpr.length} chars`);
  logger.info(`[buildZoompanExpression] x expression length: ${xExpr.length} chars`);
  logger.info(`[buildZoompanExpression] DONE`);

  return { z: zExpr, x: xExpr, y: yExpr };
}

// ─── 4. Scroll Clip Renderer ─────────────────────────────────────────────────

function createFfmpegCmd() {
  const cmd = ffmpeg();
  cmd.setFfmpegPath(getFfmpegPath());
  return cmd;
}

/**
 * Render a single scroll clip for a webtoon strip.
 * @param {string} imagePath
 * @param {Array} scrollPath  keyframes from buildScrollPath
 * @param {number} duration   seconds
 * @param {string} outputPath
 * @param {string} mood
 */
export async function renderScrollClip(imagePath, scrollPath, duration, outputPath, mood) {
  const totalFrames = Math.max(2, Math.round(Math.max(0.5, duration) * FPS));
  const fileName = path.basename(imagePath);
  logger.info(`[renderScrollClip] START — ${fileName}`);
  logger.info(`[renderScrollClip] duration=${duration.toFixed(2)}s, totalFrames=${totalFrames}, mood=${mood}`);
  logger.info(`[renderScrollClip] scrollPath has ${scrollPath?.length ?? 0} keyframe(s)`);
  logger.info(`[renderScrollClip] output: ${path.basename(outputPath)}`);

  if (scrollPath?.length) {
    scrollPath.forEach((kf, i) =>
      logger.info(`[renderScrollClip]   kf[${i}] frame=${kf.frame} y=${kf.y?.toFixed(3)} x=${kf.x?.toFixed(3)} zoom=${kf.zoom?.toFixed(3)}`)
    );
  }

  let expr = null;
  try {
    expr = buildZoompanExpression(scrollPath);
    logger.info(`[renderScrollClip] zoompan expression built: ${expr ? 'OK' : 'FAILED — using simple scroll'}`);
  } catch (err) {
    logger.warn(`[renderScrollClip] Expression build threw: ${err.message} — falling back to simple scroll`);
  }

  let vf;
  if (expr) {
    vf = [
      `scale=1200:-2:force_original_aspect_ratio=increase`,
      `zoompan=z='${expr.z}':x='${expr.x}':y='${expr.y}':d=${totalFrames}:s=1080x1920:fps=${FPS}`,
      `setsar=1`,
    ].join(',');
    logger.info(`[renderScrollClip] Using AI scroll expression (scale→zoompan→setsar)`);
  } else {
    vf = buildSimpleScrollFilter(totalFrames);
    logger.info(`[renderScrollClip] Using simple linear scroll filter (fallback)`);
  }

  logger.info(`[renderScrollClip] vf filter length: ${vf.length} chars`);
  logger.info(`[renderScrollClip] Spawning ffmpeg...`);

  return new Promise((resolve, reject) => {
    createFfmpegCmd()
      .input(imagePath)
      .outputOptions([
        '-vf', vf,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-an',
      ])
      .output(outputPath)
      .on('start', cmd => logger.info(`[renderScrollClip] ffmpeg command: ${cmd}`))
      .on('progress', p => {
        if (p.frames && p.frames % 50 === 0) {
          logger.info(`[renderScrollClip] ffmpeg progress — frames: ${p.frames}, fps: ${p.currentFps ?? '?'}, time: ${p.timemark ?? '?'}`);
        }
      })
      .on('end', () => {
        logger.info(`[renderScrollClip] DONE — ${path.basename(outputPath)}`);
        resolve();
      })
      .on('error', (err, stdout, stderr) => {
        logger.error(`[renderScrollClip] ERROR — ${path.basename(outputPath)}: ${err.message}`);
        if (stderr) logger.error(`[renderScrollClip] ffmpeg stderr: ${stderr.slice(-800)}`);
        reject(err);
      })
      .run();
  });
}

function buildSimpleScrollFilter(totalFrames) {
  logger.info(`[buildSimpleScrollFilter] Building simple top→bottom scroll, ${totalFrames} frames`);
  return [
    `scale=1200:-2:force_original_aspect_ratio=increase`,
    `zoompan=z='1.0':x='max(0,iw/2-iw/zoom/2)':y='min(on/${totalFrames}*(ih-ih/zoom),ih-ih/zoom)':d=${totalFrames}:s=1080x1920:fps=${FPS}`,
    `setsar=1`,
  ].join(',');
}

// ─── 5. Format Detection Helper ──────────────────────────────────────────────

export function isWebtoonFormat(format) {
  return format === 'webtoon';
}
