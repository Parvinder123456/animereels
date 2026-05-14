import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { get, post } from '../api/client.js';
import { useSSE } from '../hooks/useSSE.js';

/* ── Voices & aspect options ─────────────────────────────────────── */

const VOICES = [
  { id: 'en-US-GuyNeural',         label: 'Guy — Deep Male' },
  { id: 'en-US-ChristopherNeural', label: 'Christopher — Authoritative' },
  { id: 'en-US-DavisNeural',       label: 'Davis — Warm Male' },
  { id: 'en-US-AriaNeural',        label: 'Aria — Versatile Female' },
  { id: 'en-US-JennyNeural',       label: 'Jenny — Friendly Female' },
  { id: 'en-GB-RyanNeural',        label: 'Ryan — British Male' },
  { id: 'en-AU-WilliamNeural',     label: 'William — Australian Male' },
  { id: 'en-IN-PrabhatNeural',     label: 'Prabhat — Indian Male' },
];

const ASPECTS = [
  { id: '16:9', label: '16:9 Landscape' },
  { id: '9:16', label: '9:16 Vertical' },
  { id: '1:1',  label: '1:1 Square' },
];

const OUTPUT_FORMATS = [
  { id: 'recap',        label: 'Condensed Recap',     desc: 'Chronological summary of the key moments.' },
  { id: 'takeaways',    label: 'Top Takeaways',       desc: 'Numbered list of actionable insights.' },
  { id: 'motivational', label: 'Apply It / Motivational', desc: 'Inspirational spin — how to use this in your life.' },
  { id: 'highlights',   label: 'Best Moments',        desc: 'Punchy highlight reel of strongest beats.' },
];

/* ── Styles ──────────────────────────────────────────────────────── */

const s = {
  page: { display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 900, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  title: { fontSize: 22, fontWeight: 700, letterSpacing: '-0.3px' },
  meta: { fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 12, flexWrap: 'wrap' },
  card: {
    background: 'var(--bg-secondary)', border: '1px solid var(--glass-border)',
    borderRadius: 10, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10,
  },
  stepLabel: {
    fontSize: 11, fontWeight: 600, color: 'var(--accent-purple)',
    textTransform: 'uppercase', letterSpacing: '0.6px',
  },
  row: { display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 160 },
  label: { fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)' },
  hint: { fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 },
  done: { fontSize: 13, color: 'var(--success)', fontWeight: 500 },
  bar: { height: 5, borderRadius: 999, background: 'var(--glass-border)', overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 999, background: 'var(--accent-purple)', transition: 'width 0.3s' },
  err: {
    padding: '10px 14px', background: 'rgba(239,68,68,0.08)',
    border: '1px solid rgba(239,68,68,0.25)', borderRadius: 8,
    color: 'var(--error)', fontSize: 12,
  },
  connDot: (on) => ({
    width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
    background: on ? 'var(--success)' : 'var(--error)',
    boxShadow: on ? '0 0 6px var(--success)' : 'none',
  }),
  divider: { display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0' },
  dividerLine: { flex: 1, height: 1, background: 'var(--glass-border)' },
  dividerText: { fontSize: 11, color: 'var(--text-muted)' },
};

/* ── Component ───────────────────────────────────────────────────── */

export default function VideoExplainerPage() {
  const { id } = useParams();
  const { progress, connected, clearProgress } = useSSE(id);

  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Source step
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const fileInputRef = useRef(null);

  // Analysis step
  const [targetMinutes, setTargetMinutes] = useState(60);
  const [skipWindowsText, setSkipWindowsText] = useState('');
  const [forceRefresh, setForceRefresh] = useState(false);
  const [outputFormat, setOutputFormat] = useState('recap');

  // Voice step
  const [voiceId, setVoiceId] = useState(VOICES[0].id);
  const [engine, setEngine] = useState('edge');
  const [elevenVoices, setElevenVoices] = useState(null);

  // Render step
  const [aspect, setAspect] = useState('16:9');
  const [hardenEnabled, setHardenEnabled] = useState(false);
  const [hardenFlip, setHardenFlip] = useState(true);
  const [hardenPitchShift, setHardenPitchShift] = useState(true);
  const [hardenWatermark, setHardenWatermark] = useState('');

  // Title + description generator
  const [titleData, setTitleData] = useState(null);
  const [titleBusy, setTitleBusy] = useState(false);

  // YouTube upload
  const [ytAuthed, setYtAuthed] = useState(false);
  const [ytPrivacy, setYtPrivacy] = useState('private');
  const [ytUploading, setYtUploading] = useState(false);
  const [ytResult, setYtResult] = useState(null);

  // Music bed toggle (persists in project.config.musicBed)
  const [musicBedOn, setMusicBedOn] = useState(false);

  // Thumbnail
  const [thumb, setThumb] = useState(null);
  const [thumbBusy, setThumbBusy] = useState(false);

  // Translation
  const [languages, setLanguages] = useState([]);
  const [translateLang, setTranslateLang] = useState('');
  const [translating, setTranslating] = useState(false);

  // Auto-Shorts
  const [shortsManifest, setShortsManifest] = useState(null);
  const [shortsBusy, setShortsBusy] = useState(false);
  const [shortsCount, setShortsCount] = useState(8);
  const [shortsAspect, setShortsAspect] = useState('9:16');
  const [shortsImportance, setShortsImportance] = useState(4);

  // Preview
  const [preview, setPreview] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [expandedScenes, setExpandedScenes] = useState(new Set());

  /* ── Data loading ───────────────────────────────────────────────── */

  const reload = useCallback(async () => {
    try { setProject(await get(`/projects/${id}`)); }
    catch (e) { setError(e.message); }
  }, [id]);

  // Load project once on mount
  useEffect(() => { reload(); }, [reload]);

  // Reload project when a step completes (progress hits 100 or -1)
  useEffect(() => {
    if (progress && (progress.percent === 100 || progress.percent === -1)) {
      reload();
    }
  }, [progress?.percent, progress?.step, reload]);

  // Prefill skip windows from saved config
  useEffect(() => {
    const saved = project?.config?.manualSkipWindows;
    if (Array.isArray(saved) && saved.length && !skipWindowsText) {
      setSkipWindowsText(saved.map(w => `${fmtTime(w.startSec)}-${fmtTime(w.endSec)}`).join('\n'));
    }
  }, [project?.config?.manualSkipWindows]);

  // Load preview when script is ready
  useEffect(() => {
    if (project?.state?.script === 'complete') {
      get(`/projects/${id}/explainer/preview`).then(setPreview).catch(() => {});
    }
  }, [project?.state?.script, project?.updatedAt, id]);

  // Hydrate saved render config from project.json
  useEffect(() => {
    const cfg = project?.config;
    if (!cfg) return;
    if (typeof cfg.outputFormat === 'string' && OUTPUT_FORMATS.some(f => f.id === cfg.outputFormat)) {
      setOutputFormat(cfg.outputFormat);
    }
    const hc = cfg.copyrightHardening;
    if (hc && typeof hc === 'object' && hc.enabled !== false) {
      setHardenEnabled(true);
      if (hc.flip === false) setHardenFlip(false);
      if (hc.pitchShift === false) setHardenPitchShift(false);
      if (typeof hc.watermark === 'string') setHardenWatermark(hc.watermark);
    }
  }, [project?.config?.outputFormat, project?.config?.copyrightHardening]);

  // Auto-load generated title/description if it exists
  useEffect(() => {
    if (project?.state?.script === 'complete') {
      get(`/projects/${id}/explainer/title`).then(setTitleData).catch(() => {});
    }
  }, [project?.state?.script, project?.updatedAt, id]);

  // YouTube auth status
  useEffect(() => {
    get('/youtube/status').then(d => setYtAuthed(!!d?.authenticated)).catch(() => {});
  }, []);

  // ElevenLabs voices when engine flips
  useEffect(() => {
    if (engine === 'elevenlabs') {
      setVoiceId('');
      if (!elevenVoices) {
        get('/voice/elevenlabs/voices').then(d => {
          if (Array.isArray(d?.voices)) setElevenVoices(d.voices);
          else setElevenVoices([]);
        }).catch(() => setElevenVoices([]));
      }
    }
    if (engine === 'edge') {
      setVoiceId(VOICES[0].id);
    }
  }, [engine]);

  // Music bed toggle hydrates from project.config
  useEffect(() => {
    if (typeof project?.config?.musicBed === 'boolean') {
      setMusicBedOn(project.config.musicBed);
    }
  }, [project?.config?.musicBed]);

  // Supported translation languages
  useEffect(() => {
    if (analyzeDone && !languages.length) {
      get(`/projects/${id}/explainer/languages`).then(d => {
        if (Array.isArray(d?.languages)) setLanguages(d.languages);
      }).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.state?.script]);

  // Auto-load Shorts manifest if a previous run exists
  useEffect(() => {
    if (project?.state?.script === 'complete') {
      fetch(`/api/projects/${id}/explainer/shorts`)
        .then(r => r.status === 200 ? r.json() : null)
        .then(d => d && setShortsManifest(d))
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.state?.script, project?.updatedAt]);

  // SSE 'shorts' step finished → refresh manifest
  useEffect(() => {
    if (progress?.step === 'shorts' && progress?.percent === 100) {
      fetch(`/api/projects/${id}/explainer/shorts`)
        .then(r => r.status === 200 ? r.json() : null)
        .then(d => d && setShortsManifest(d))
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.step, progress?.percent]);

  /* ── Helpers ────────────────────────────────────────────────────── */

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const ss = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    return `${m}:${String(ss).padStart(2, '0')}`;
  }

  function toggleScene(idx) {
    setExpandedScenes(prev => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  }

  async function act(fn) {
    setError(null);
    setBusy(true);
    clearProgress();
    try { await fn(); await reload(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  /* ── Actions ────────────────────────────────────────────────────── */

  const handleYoutubeDownload = (e) => {
    e.preventDefault();
    if (!youtubeUrl.trim()) return setError('Paste a YouTube URL');
    act(() => post(`/projects/${id}/explainer-youtube`, { url: youtubeUrl.trim() }));
  };

  const handleUpload = (e) => {
    e.preventDefault();
    const files = Array.from(fileInputRef.current?.files || []);
    if (!files.length) return setError('Pick 1-10 video files');
    act(async () => {
      const form = new FormData();
      files.forEach(f => form.append('videos', f));
      const res = await fetch(`/api/projects/${id}/explainer-sources`, { method: 'POST', body: form });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    });
  };

  const runPipeline = () => act(() => post(`/projects/${id}/explainer/run`, {
    targetDurationSec: Math.max(60, Number(targetMinutes) * 60),
    language: 'en', force: forceRefresh,
    manualSkipWindows: skipWindowsText.trim(),
    outputFormat,
  }));

  const regenerateScript = () => act(() => post(`/projects/${id}/explainer/run`, {
    targetDurationSec: Math.max(60, Number(targetMinutes) * 60),
    language: 'en', force: false,
    manualSkipWindows: skipWindowsText.trim(),
    outputFormat,
  }));

  const generateVoice = () => act(() => post(`/projects/${id}/voice/generate`, { voiceId, engine }));

  const renderVideo = () => act(() => post(`/projects/${id}/render`, {
    aspect,
    copyrightHardening: hardenEnabled
      ? { enabled: true, flip: hardenFlip, pitchShift: hardenPitchShift, watermark: hardenWatermark.trim() }
      : false,
  }));

  const generateTitle = async () => {
    setError(null); setTitleBusy(true);
    try {
      const r = await post(`/projects/${id}/explainer/title`, {});
      setTitleData(r);
    } catch (e) { setError(e.message); }
    finally { setTitleBusy(false); }
  };

  const copy = (text) => navigator.clipboard?.writeText(text || '').catch(() => {});

  const uploadToYouTube = async () => {
    setError(null); setYtUploading(true); setYtResult(null);
    try {
      const form = new FormData();
      if (titleData?.titles?.[0]) form.append('title', titleData.titles[0]);
      if (titleData?.description) form.append('description', titleData.description);
      if (Array.isArray(titleData?.tags)) form.append('tags', JSON.stringify(titleData.tags));
      form.append('privacy', ytPrivacy);
      // If a thumbnail was generated, fetch + attach it
      if (thumb?.url) {
        try {
          const tr = await fetch(thumb.url);
          if (tr.ok) {
            const blob = await tr.blob();
            form.append('thumbnail', blob, 'thumbnail.jpg');
          }
        } catch {}
      }
      const res = await fetch(`/api/youtube/upload/${id}`, { method: 'POST', body: form });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const data = await res.json();
      setYtResult({ started: data?.started === true });
    } catch (e) { setError(e.message); }
    finally { setYtUploading(false); }
  };

  const toggleMusicBed = async (next) => {
    setMusicBedOn(next);
    try { await fetch(`/api/projects/${id}/explainer/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ musicBed: next }),
    }); } catch {}
  };

  const generateThumb = async () => {
    setError(null); setThumbBusy(true);
    try {
      const r = await post(`/projects/${id}/explainer/thumbnail`, { aspect, force: true });
      setThumb(r);
    } catch (e) { setError(e.message); }
    finally { setThumbBusy(false); }
  };

  const translateScriptUI = async () => {
    if (!translateLang) return setError('Pick a language first');
    setError(null); setTranslating(true);
    try {
      await post(`/projects/${id}/explainer/translate`, { language: translateLang });
      // The translate job runs in background and posts SSE — we just kick it.
    } catch (e) { setError(e.message); }
    finally { setTranslating(false); }
  };

  const generateShorts = async () => {
    setError(null); setShortsBusy(true);
    try {
      await post(`/projects/${id}/explainer/shorts`, {
        count: Number(shortsCount),
        aspect: shortsAspect,
        importance: Number(shortsImportance),
        minSec: 30, maxSec: 60, subtitles: true,
      });
      // Background job — manifest will refresh via SSE/effect.
    } catch (e) { setError(e.message); }
    finally { setShortsBusy(false); }
  };

  /* ── Derived state ──────────────────────────────────────────────── */

  const state        = project?.state || {};
  const sourceReady  = state.upload === 'complete';
  const analyzeDone  = state.script === 'complete';
  const voiceDone    = state.voice  === 'complete';
  const renderDone   = state.render === 'complete';
  const lastErr      = (project?.errors || []).slice(-1)[0];
  const sourceMin    = project?.stats?.videoDurationSec ? (project.stats.videoDurationSec / 60).toFixed(1) : null;

  const isWorking = busy || (progress && progress.percent > 0 && progress.percent < 100);

  /* ── Render ─────────────────────────────────────────────────────── */

  return (
    <div style={s.page} className="fade-in">

      {/* Header */}
      <div style={s.header}>
        <h1 style={s.title}>{project?.name || 'Video Explainer'}</h1>
        <div style={s.meta}>
          {sourceMin && <span>Source: {sourceMin} min</span>}
          {project?.stats?.panelCount > 0 && <span>{project.stats.panelCount} scenes</span>}
          {project?.stats?.scriptWordCount > 0 && <span>{project.stats.scriptWordCount} words</span>}
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={s.connDot(connected)} />
            <span style={{ fontSize: 10 }}>{connected ? 'Live' : 'Reconnecting...'}</span>
          </span>
        </div>
      </div>

      {/* Errors */}
      {error && <div style={s.err}>{error}</div>}
      {lastErr && !error && <div style={s.err}>Last error ({lastErr.step}): {lastErr.message}</div>}

      {/* Progress bar */}
      {progress && progress.percent >= 0 && progress.percent < 100 && (
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={s.stepLabel}>{progress.step}</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{progress.percent}%</span>
          </div>
          <div style={s.bar}>
            <div style={{ ...s.barFill, width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{progress.message}</div>
        </div>
      )}

      {/* ── Step 1: Source ──────────────────────────────────────────── */}
      <div style={s.card}>
        <div style={s.stepLabel}>Step 1 &middot; Source video</div>
        {sourceReady ? (
          <div style={s.done}>Source ready{sourceMin ? ` (${sourceMin} min)` : ''}</div>
        ) : (
          <>
            <form onSubmit={handleYoutubeDownload} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div style={{ ...s.field, flex: 2 }}>
                <label style={s.label}>YouTube URL</label>
                <input
                  type="text" placeholder="https://www.youtube.com/watch?v=..."
                  value={youtubeUrl} onChange={e => setYoutubeUrl(e.target.value)}
                />
              </div>
              <button type="submit" className="btn-primary" disabled={isWorking} style={{ whiteSpace: 'nowrap' }}>
                Download
              </button>
            </form>

            <div style={s.divider}>
              <div style={s.dividerLine} />
              <span style={s.dividerText}>or upload files</span>
              <div style={s.dividerLine} />
            </div>

            <form onSubmit={handleUpload} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div style={{ ...s.field, flex: 2 }}>
                <input type="file" accept="video/mp4,video/x-matroska,video/quicktime,video/webm" multiple ref={fileInputRef} />
              </div>
              <button type="submit" className="btn-primary" disabled={isWorking} style={{ whiteSpace: 'nowrap' }}>
                Upload
              </button>
            </form>
            <div style={s.hint}>Max 10 files, 3 GB each. Server stitches into one source.</div>
          </>
        )}
      </div>

      {/* ── Step 2: Analyze ─────────────────────────────────────────── */}
      <div style={{ ...s.card, opacity: sourceReady ? 1 : 0.4, pointerEvents: sourceReady ? 'auto' : 'none' }}>
        <div style={s.stepLabel}>Step 2 &middot; AI analysis + script</div>
        <div style={s.row}>
          <div style={s.field}>
            <label style={s.label}>Target output (minutes)</label>
            <input type="number" min="2" max="180" value={targetMinutes} onChange={e => setTargetMinutes(e.target.value)} />
          </div>
          <div style={s.field}>
            <label style={s.label}>Output format</label>
            <select value={outputFormat} onChange={e => setOutputFormat(e.target.value)}>
              {OUTPUT_FORMATS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
            <div style={s.hint}>{OUTPUT_FORMATS.find(f => f.id === outputFormat)?.desc}</div>
          </div>
          <button className="btn-primary" onClick={runPipeline} disabled={isWorking || !sourceReady}>
            {analyzeDone ? 'Re-analyze' : 'Analyze'}
          </button>
        </div>

        <details>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)' }}>
            Skip windows + advanced options
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            <div style={s.field}>
              <label style={s.label}>Manual skip windows (one per line)</label>
              <textarea
                rows={3}
                placeholder={`0:00-1:30\n22:00-24:00`}
                value={skipWindowsText}
                onChange={e => setSkipWindowsText(e.target.value)}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
              <div style={s.hint}>
                Time ranges to cut (stitched timeline). Merged with auto-detected OP/ED.
              </div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={forceRefresh} onChange={e => setForceRefresh(e.target.checked)} />
              Force full re-analysis (skip cache)
            </label>
          </div>
        </details>

        {analyzeDone && <div style={s.done}>Script + scenes ready</div>}
      </div>

      {/* ── Preview ─────────────────────────────────────────────────── */}
      {analyzeDone && preview && (
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div style={s.stepLabel}>Script preview</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn-secondary" onClick={regenerateScript} disabled={isWorking} style={{ fontSize: 11, padding: '4px 10px' }}>
                Re-generate script
              </button>
              <button className="btn-secondary" onClick={() => setPreviewOpen(o => !o)} style={{ fontSize: 11, padding: '4px 10px' }}>
                {previewOpen ? 'Collapse' : 'Expand'}
              </button>
            </div>
          </div>

          {previewOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{preview.title || '(untitled)'}</div>
                {preview.hook && <div style={{ fontStyle: 'italic', color: 'var(--text-secondary)', marginTop: 4, fontSize: 13 }}>"{preview.hook}"</div>}
              </div>

              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-muted)' }}>
                <span>{preview.stats.sceneCount} scenes</span>
                <span>{preview.stats.totalWords} words</span>
                {preview.stats.mode && <span>mode: {preview.stats.mode}</span>}
                {preview.stats.sourceDurationSec && <span>source: {fmtTime(preview.stats.sourceDurationSec)}</span>}
                {preview.stats.targetDurationSec && <span>target: {fmtTime(preview.stats.targetDurationSec)}</span>}
              </div>

              {preview.bundle && (
                <details>
                  <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)' }}>
                    Content context (what the narrator knows)
                  </summary>
                  <div style={{ padding: '6px 0', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                    {preview.bundle.arcSummary && <div><strong>Summary:</strong> {preview.bundle.arcSummary}</div>}
                    {Array.isArray(preview.bundle.characters) && preview.bundle.characters.length > 0 && (
                      <div style={{ marginTop: 4 }}>
                        <strong>Speakers:</strong>{' '}
                        {preview.bundle.characters.map(c => `${c.name} (${c.role})`).join(', ')}
                      </div>
                    )}
                    {Array.isArray(preview.bundle.throughLines) && preview.bundle.throughLines.length > 0 && (
                      <div style={{ marginTop: 4 }}><strong>Key threads:</strong> {preview.bundle.throughLines.join('; ')}</div>
                    )}
                  </div>
                </details>
              )}

              {/* Scene list */}
              <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: 8 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                  {preview.scenes.length} scenes — click to expand
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 500, overflowY: 'auto' }}>
                  {preview.scenes.map(sc => {
                    const isOpen = expandedScenes.has(sc.sceneIndex);
                    return (
                      <div key={sc.sceneIndex} style={{
                        border: '1px solid var(--glass-border)', borderRadius: 6,
                        padding: '6px 10px', background: 'rgba(255,255,255,0.02)',
                      }}>
                        <div
                          onClick={() => toggleScene(sc.sceneIndex)}
                          style={{ cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'center', fontSize: 11 }}
                        >
                          <span style={{ color: 'var(--text-muted)', minWidth: 24, textAlign: 'right', fontFamily: 'monospace' }}>#{sc.sceneIndex}</span>
                          <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace', minWidth: 90 }}>
                            {fmtTime(sc.sourceStart)}-{fmtTime(sc.sourceEnd)}
                          </span>
                          {sc.mood && <span style={{ color: 'var(--accent-purple)', minWidth: 60, fontSize: 10 }}>{sc.mood}</span>}
                          <span style={{ flex: 1, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {sc.narration || '(breathe)'}
                          </span>
                          <span style={{ color: 'var(--text-muted)', fontSize: 9 }}>{isOpen ? '\u25BC' : '\u25B6'}</span>
                        </div>
                        {isOpen && (
                          <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--glass-border)', fontSize: 11, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {sc.visualDescription && <div><strong style={{ color: 'var(--accent-cyan)' }}>Visual:</strong> {sc.visualDescription}</div>}
                            {sc.dialogueGist && <div><strong style={{ color: 'var(--accent-cyan)' }}>Says:</strong> {sc.dialogueGist}</div>}
                            {sc.dialogueVerbatim && <div><strong style={{ color: 'var(--accent-cyan)' }}>Verbatim:</strong> {sc.dialogueVerbatim}</div>}
                            <div style={{ marginTop: 4, padding: 6, background: 'rgba(139,92,246,0.06)', borderRadius: 4, color: 'var(--text-primary)', lineHeight: 1.5 }}>
                              <strong style={{ color: 'var(--accent-purple)' }}>Narration:</strong> {sc.narration || '(silent / breathe)'}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Title + description card ───────────────────────────────── */}
      {analyzeDone && (
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div style={s.stepLabel}>YouTube title + description</div>
            <button className="btn-secondary" onClick={generateTitle} disabled={titleBusy} style={{ fontSize: 11, padding: '4px 10px' }}>
              {titleBusy ? 'Generating…' : (titleData ? 'Re-generate' : 'Generate')}
            </button>
          </div>
          {!titleData && !titleBusy && (
            <div style={s.hint}>Click Generate to produce 3 title variants + description + tags from the script.</div>
          )}
          {titleData?.titles?.length > 0 && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {titleData.titles.map((t, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 24 }}>#{i + 1}</span>
                    <span style={{ flex: 1, fontSize: 13, color: 'var(--text-primary)' }}>{t}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{t.length}ch</span>
                    <button className="btn-secondary" onClick={() => copy(t)} style={{ fontSize: 10, padding: '2px 6px' }}>Copy</button>
                  </div>
                ))}
              </div>
              {titleData.description && (
                <div style={{ marginTop: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Description ({titleData.description.length} chars)</span>
                    <button className="btn-secondary" onClick={() => copy(titleData.description)} style={{ fontSize: 10, padding: '2px 6px' }}>Copy</button>
                  </div>
                  <pre style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto', margin: '6px 0 0 0', padding: 8, background: 'rgba(255,255,255,0.03)', borderRadius: 4 }}>
                    {titleData.description}
                  </pre>
                </div>
              )}
              {Array.isArray(titleData.tags) && titleData.tags.length > 0 && (
                <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Tags:</span>
                  <span style={{ flex: 1, fontSize: 11, color: 'var(--text-secondary)' }}>{titleData.tags.join(', ')}</span>
                  <button className="btn-secondary" onClick={() => copy(titleData.tags.join(', '))} style={{ fontSize: 10, padding: '2px 6px' }}>Copy</button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Step 3: Voice ───────────────────────────────────────────── */}
      <div style={{ ...s.card, opacity: analyzeDone ? 1 : 0.4, pointerEvents: analyzeDone ? 'auto' : 'none' }}>
        <div style={s.stepLabel}>Step 3 &middot; Generate narration</div>
        <div style={s.row}>
          <div style={s.field}>
            <label style={s.label}>Voice</label>
            <select value={voiceId} onChange={e => setVoiceId(e.target.value)}>
              {engine === 'elevenlabs'
                ? <>
                    <option value="">Default (from .env)</option>
                    {Array.isArray(elevenVoices) && elevenVoices.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                  </>
                : VOICES.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </div>
          <div style={s.field}>
            <label style={s.label}>Engine</label>
            <select value={engine} onChange={e => setEngine(e.target.value)}>
              <option value="edge">Edge TTS (free)</option>
              <option value="elevenlabs">ElevenLabs (paid)</option>
            </select>
            {engine === 'elevenlabs' && elevenVoices === null && (
              <div style={s.hint}>Loading ElevenLabs voices…</div>
            )}
          </div>
          <button className="btn-primary" onClick={generateVoice} disabled={isWorking || !analyzeDone}>
            {voiceDone ? 'Re-generate' : 'Generate'}
          </button>
        </div>
        {voiceDone && <div style={s.done}>Narration audio ready</div>}
      </div>

      {/* ── Step 4: Render ──────────────────────────────────────────── */}
      <div style={{ ...s.card, opacity: voiceDone ? 1 : 0.4, pointerEvents: voiceDone ? 'auto' : 'none' }}>
        <div style={s.stepLabel}>Step 4 &middot; Render video</div>
        <div style={s.row}>
          <div style={s.field}>
            <label style={s.label}>Aspect ratio</label>
            <select value={aspect} onChange={e => setAspect(e.target.value)}>
              {ASPECTS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </div>
          <button className="btn-primary" onClick={renderVideo} disabled={isWorking || !voiceDone}>
            {renderDone ? 'Re-render' : 'Render'}
          </button>
          {renderDone && (
            <a className="btn-secondary" href={`/api/projects/${id}/download`} download style={{ whiteSpace: 'nowrap' }}>
              Download
            </a>
          )}
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={musicBedOn} onChange={e => toggleMusicBed(e.target.checked)} />
          Background music bed (drop .mp3 files in <code>music/</code>, named by mood: lofi-calm.mp3, cinematic-dramatic.mp3, etc.)
        </label>

        <details>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)' }}>
            Copyright hardening (Content ID evasion)
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={hardenEnabled} onChange={e => setHardenEnabled(e.target.checked)} />
              <strong>Enable hardening</strong> — applies hue/contrast shift, 1.5% crop, +1% audio pitch, optional flip & watermark
            </label>
            {hardenEnabled && (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                  <input type="checkbox" checked={hardenFlip} onChange={e => setHardenFlip(e.target.checked)} />
                  Horizontal flip (mirror)
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                  <input type="checkbox" checked={hardenPitchShift} onChange={e => setHardenPitchShift(e.target.checked)} />
                  +1% pitch shift on source audio (preserves duration)
                </label>
                <div style={s.field}>
                  <label style={s.label}>Watermark text (optional)</label>
                  <input
                    type="text" maxLength={60}
                    placeholder="e.g. Your Channel Name"
                    value={hardenWatermark}
                    onChange={e => setHardenWatermark(e.target.value)}
                  />
                  <div style={s.hint}>Burned into top-right corner. Leave blank to skip.</div>
                </div>
              </>
            )}
          </div>
        </details>

        {renderDone && <div style={s.done}>Video ready</div>}
      </div>

      {/* ── Thumbnail + multi-language (P2 extras) ─────────────────── */}
      {analyzeDone && (
        <div style={s.card}>
          <div style={s.stepLabel}>Thumbnail + translations</div>
          <div style={s.row}>
            <button className="btn-secondary" onClick={generateThumb} disabled={thumbBusy}>
              {thumbBusy ? 'Generating…' : (thumb ? 'Re-generate thumbnail' : 'Generate thumbnail')}
            </button>
            {thumb?.url && (
              <a href={thumb.url} target="_blank" rel="noreferrer" style={{ display: 'inline-block' }}>
                <img src={thumb.url} alt="thumbnail" style={{ height: 64, borderRadius: 4, border: '1px solid var(--glass-border)' }} />
              </a>
            )}
          </div>
          {thumb?.placement && (
            <div style={s.hint}>
              Headline: <strong>"{thumb.placement.headline}"</strong> · placement {thumb.placement.placement} · color {thumb.placement.accentColor}
            </div>
          )}

          <div style={s.row}>
            <div style={s.field}>
              <label style={s.label}>Translate script to</label>
              <select value={translateLang} onChange={e => setTranslateLang(e.target.value)}>
                <option value="">— pick a language —</option>
                {languages.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            </div>
            <button className="btn-secondary" onClick={translateScriptUI} disabled={translating || !translateLang}>
              {translating ? 'Starting…' : 'Translate'}
            </button>
          </div>
          <div style={s.hint}>
            Produces <code>script-&lt;lang&gt;.json</code>. Generate narration again with a matching voice (e.g. en-IN-PrabhatNeural for Hindi) to render a translated version.
          </div>
        </div>
      )}

      {/* ── Auto-Shorts ─────────────────────────────────────────────── */}
      {analyzeDone && (
        <div style={s.card}>
          <div style={s.stepLabel}>Auto-Shorts (vertical clips from high-importance scenes)</div>
          <div style={s.row}>
            <div style={s.field}>
              <label style={s.label}>How many</label>
              <input type="number" min="1" max="20" value={shortsCount} onChange={e => setShortsCount(e.target.value)} />
            </div>
            <div style={s.field}>
              <label style={s.label}>Min importance</label>
              <select value={shortsImportance} onChange={e => setShortsImportance(Number(e.target.value))}>
                <option value="3">3 — looser (more clips)</option>
                <option value="4">4 — balanced</option>
                <option value="5">5 — strict (only top moments)</option>
              </select>
            </div>
            <div style={s.field}>
              <label style={s.label}>Aspect</label>
              <select value={shortsAspect} onChange={e => setShortsAspect(e.target.value)}>
                <option value="9:16">9:16 Vertical (Shorts/Reels)</option>
                <option value="1:1">1:1 Square</option>
                <option value="16:9">16:9 Landscape</option>
              </select>
            </div>
            <button className="btn-secondary" onClick={generateShorts} disabled={shortsBusy}>
              {shortsBusy ? 'Starting…' : (shortsManifest ? 'Re-generate Shorts' : 'Generate Shorts')}
            </button>
          </div>
          <div style={s.hint}>
            Pulls clusters of scenes scoring &ge; min importance from the cached scene plan,
            clamps each to 30-60s, smart-crops to the aspect, and burns subtitles from the
            scene-level dialogue. No additional Gemini cost.
          </div>

          {shortsManifest?.clips?.length > 0 && (
            <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: 8, marginTop: 4 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                {shortsManifest.clips.length} Shorts ready ({shortsManifest.aspect})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {shortsManifest.clips.map(c => (
                  <div key={c.index} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '6px 10px', borderRadius: 6,
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid var(--glass-border)',
                  }}>
                    <span style={{ color: 'var(--text-muted)', minWidth: 26, textAlign: 'right', fontFamily: 'monospace', fontSize: 11 }}>
                      #{String(c.index + 1).padStart(2, '0')}
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace', fontSize: 11, minWidth: 90 }}>
                      {fmtTime(c.startSec)}-{fmtTime(c.endSec)}
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11, minWidth: 40 }}>
                      {Math.round(c.durationSec)}s
                    </span>
                    <span style={{ flex: 1, color: 'var(--text-primary)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.title}
                    </span>
                    <a className="btn-secondary" href={c.url} download style={{ fontSize: 11, padding: '3px 8px' }}>
                      Download
                    </a>
                    <a className="btn-secondary" href={c.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, padding: '3px 8px' }}>
                      Preview
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── YouTube upload ──────────────────────────────────────────── */}
      {renderDone && (
        <div style={s.card}>
          <div style={s.stepLabel}>YouTube upload</div>
          {!ytAuthed ? (
            <div style={s.hint}>
              YouTube OAuth not configured. Place <code>youtube-credentials.json</code> in project root
              and visit <code>/api/youtube/auth-url</code> to authorize.
            </div>
          ) : (
            <>
              <div style={s.row}>
                <div style={s.field}>
                  <label style={s.label}>Privacy</label>
                  <select value={ytPrivacy} onChange={e => setYtPrivacy(e.target.value)}>
                    <option value="private">Private</option>
                    <option value="unlisted">Unlisted</option>
                    <option value="public">Public</option>
                  </select>
                </div>
                <button className="btn-primary" onClick={uploadToYouTube} disabled={ytUploading || !renderDone}>
                  {ytUploading ? 'Starting…' : 'Upload to YouTube'}
                </button>
              </div>
              <div style={s.hint}>
                Uses the generated title + description above. Progress shows in the SSE bar.
                {!titleData && ' (Click "Generate" in the title card first for an AI-written title.)'}
              </div>
              {ytResult?.started && <div style={s.done}>Upload started — watch the progress bar.</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
