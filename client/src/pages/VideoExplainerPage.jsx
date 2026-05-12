import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { get, post } from '../api/client.js';
import { useSSE } from '../hooks/useSSE.js';

const styles = {
  page: { display: 'flex', flexDirection: 'column', gap: 24 },
  title: { fontSize: 24, fontWeight: 700, letterSpacing: '-0.5px' },
  card: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--glass-border)',
    borderRadius: 12,
    padding: 24,
    display: 'flex', flexDirection: 'column', gap: 12,
  },
  step: { fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' },
  progress: { fontSize: 13, color: 'var(--text-secondary)' },
  bar: { height: 6, borderRadius: 999, background: 'var(--glass-border)', overflow: 'hidden' },
  barFill: { height: '100%', background: 'var(--accent-purple)', transition: 'width 0.3s' },
  row: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 200 },
  errorBanner: {
    padding: '12px 16px', background: 'rgba(239,68,68,0.10)',
    border: '1px solid rgba(239,68,68,0.30)', borderRadius: 8,
    color: 'var(--error)', fontSize: 13,
  },
  hint: { fontSize: 12, color: 'var(--text-muted)' },
};

const VOICES = [
  { id: 'en-US-GuyNeural',         label: 'Guy — Deep Male Narrator' },
  { id: 'en-US-ChristopherNeural', label: 'Christopher — Authoritative' },
  { id: 'en-US-AriaNeural',        label: 'Aria — Versatile Female' },
];

const ASPECTS = [
  { id: '16:9', label: '16:9 — YouTube long-form' },
  { id: '9:16', label: '9:16 — Vertical / Shorts' },
  { id: '1:1',  label: '1:1 — Square' },
];

export default function VideoExplainerPage() {
  const { id } = useParams();
  const progress = useSSE(id);
  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [targetMinutes, setTargetMinutes] = useState(60);
  const [voiceId, setVoiceId] = useState(VOICES[0].id);
  const [engine, setEngine] = useState('edge');
  const [aspect, setAspect] = useState('16:9');
  const [forceRefresh, setForceRefresh] = useState(false);
  const fileInputRef = useRef(null);
  const [fileNames, setFileNames] = useState([]);

  useEffect(() => {
    reload();
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [id]);

  async function reload() {
    try { setProject(await get(`/projects/${id}`)); }
    catch (e) { setError(e.message); }
  }

  async function handleUpload(e) {
    e.preventDefault();
    const files = Array.from(fileInputRef.current?.files || []);
    if (!files.length) return setError('Pick 1–10 video files (episode order matters)');
    setError(null); setBusy(true);
    try {
      const form = new FormData();
      files.forEach(f => form.append('videos', f));
      const res = await fetch(`/api/projects/${id}/explainer-sources`, { method: 'POST', body: form });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      setFileNames(files.map(f => f.name));
      await reload();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function runPipeline() {
    setError(null); setBusy(true);
    try {
      await post(`/projects/${id}/explainer/run`, {
        targetDurationSec: Math.max(60, Number(targetMinutes) * 60),
        language: 'en',
        force: forceRefresh,
      });
      await reload();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function generateVoice() {
    setError(null); setBusy(true);
    try {
      await post(`/projects/${id}/voice/generate`, { voiceId, engine });
      await reload();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function renderVideo() {
    setError(null); setBusy(true);
    try {
      await post(`/projects/${id}/render`, { aspect });
      await reload();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const state = project?.state || {};
  const sourceUploaded = state.upload === 'complete' || fileNames.length > 0;
  const analyzeDone = state.script === 'complete';
  const voiceDone   = state.voice === 'complete';
  const renderDone  = state.render === 'complete';
  const lastErr     = (project?.errors || []).slice(-1)[0];

  const sourceMin   = project?.stats?.videoDurationSec ? (project.stats.videoDurationSec / 60).toFixed(1) : null;
  const beatCount   = project?.stats?.panelCount;
  const wordCount   = project?.stats?.scriptWordCount;

  return (
    <div style={styles.page} className="fade-in">
      <div style={styles.title}>{project?.name || 'Anime Explainer'}</div>
      {sourceMin && (
        <div style={styles.hint}>
          Source: {sourceMin} min{beatCount ? ` · ${beatCount} beats` : ''}{wordCount ? ` · ${wordCount} narration words` : ''}
        </div>
      )}

      {error && <div style={styles.errorBanner}>{error}</div>}
      {lastErr && <div style={styles.errorBanner}>Last error ({lastErr.step}): {lastErr.message}</div>}

      {progress && progress.percent >= 0 && (
        <div style={styles.card}>
          <div style={styles.step}>{progress.step}</div>
          <div style={styles.progress}>{progress.message}</div>
          <div style={styles.bar}>
            <div style={{ ...styles.barFill, width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
          </div>
        </div>
      )}

      <div style={styles.card}>
        <div style={styles.step}>1 · Upload episodes (in order)</div>
        {sourceUploaded ? (
          <div style={styles.progress}>
            ✓ Source stitched ({fileNames.length ? fileNames.join(', ') : 'episodes.json available'})
          </div>
        ) : (
          <form onSubmit={handleUpload} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              type="file"
              accept="video/mp4,video/x-matroska,video/quicktime,video/webm"
              multiple
              ref={fileInputRef}
            />
            <div style={styles.hint}>
              Select 1-10 episode files. Backend stitches them into one source. File order is preserved.
            </div>
            <button type="submit" className="btn-primary" disabled={busy} style={{ alignSelf: 'flex-start' }}>
              Upload + stitch
            </button>
          </form>
        )}
      </div>

      <div style={styles.card}>
        <div style={styles.step}>2 · Analyze → script (OP/ED auto-cut, Gemini multimodal scene breakdown)</div>
        <div style={styles.row}>
          <div style={styles.field}>
            <label>Target output (minutes)</label>
            <input
              type="number"
              min="2"
              max="180"
              value={targetMinutes}
              onChange={e => setTargetMinutes(e.target.value)}
            />
            <div style={styles.hint}>
              Auto mode: ratio &gt; 3.5 = cut, &lt; 2.5 = continuous, else hybrid. Source ÷ target = ratio.
            </div>
          </div>
          <button className="btn-primary" onClick={runPipeline} disabled={busy || !sourceUploaded}>
            {analyzeDone ? 'Re-run analysis' : 'Run analysis'}
          </button>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={forceRefresh} onChange={e => setForceRefresh(e.target.checked)} />
          Force re-run from scratch (skip scene-plan + OP/ED cache — costs ~$0.90 in Gemini if free tier is exhausted)
        </label>
        <div style={styles.hint}>
          By default, re-running with the same source skips the Gemini multimodal breakdown
          (the most expensive step). Only the scene-selection + script-writer steps re-run.
        </div>
        {analyzeDone && <div style={styles.progress}>✓ Script + scenes ready</div>}
      </div>

      <div style={styles.card}>
        <div style={styles.step}>3 · Generate narration</div>
        <div style={styles.row}>
          <div style={styles.field}>
            <label>Voice</label>
            <select value={voiceId} onChange={e => setVoiceId(e.target.value)}>
              {VOICES.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </div>
          <div style={styles.field}>
            <label>Engine</label>
            <select value={engine} onChange={e => setEngine(e.target.value)}>
              <option value="edge">Edge TTS (free)</option>
              <option value="elevenlabs">ElevenLabs</option>
            </select>
          </div>
          <button className="btn-primary" onClick={generateVoice} disabled={busy || !analyzeDone}>
            {voiceDone ? 'Re-generate' : 'Generate'}
          </button>
        </div>
        {voiceDone && <div style={styles.progress}>✓ Narration ready</div>}
      </div>

      <div style={styles.card}>
        <div style={styles.step}>4 · Render (with YouTube-safety: ducked source audio, +1% pitch shift, OP/ED cut)</div>
        <div style={styles.row}>
          <div style={styles.field}>
            <label>Aspect</label>
            <select value={aspect} onChange={e => setAspect(e.target.value)}>
              {ASPECTS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </div>
          <button className="btn-primary" onClick={renderVideo} disabled={busy || !voiceDone}>
            {renderDone ? 'Re-render' : 'Render explainer'}
          </button>
          {renderDone && (
            <a className="btn-secondary" href={`/api/projects/${id}/download`} download>Download</a>
          )}
        </div>
      </div>
    </div>
  );
}
