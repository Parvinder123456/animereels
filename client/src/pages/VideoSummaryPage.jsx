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
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  step: { fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' },
  progress: { fontSize: 13, color: 'var(--text-secondary)' },
  bar: {
    height: 6, borderRadius: 999, background: 'var(--glass-border)', overflow: 'hidden',
  },
  barFill: { height: '100%', background: 'var(--accent-purple)', transition: 'width 0.3s' },
  row: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 200 },
  errorBanner: {
    padding: '12px 16px', background: 'rgba(239,68,68,0.10)',
    border: '1px solid rgba(239,68,68,0.30)', borderRadius: 8,
    color: 'var(--error)', fontSize: 13,
  },
};

const VOICES = [
  { id: 'en-US-GuyNeural',         label: 'Guy — Deep Male Narrator' },
  { id: 'en-US-ChristopherNeural', label: 'Christopher — Authoritative' },
  { id: 'en-US-AriaNeural',        label: 'Aria — Versatile Female' },
];

export default function VideoSummaryPage() {
  const { id } = useParams();
  const progress = useSSE(id);
  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [duration, setDuration] = useState(180);
  const [voiceId, setVoiceId] = useState(VOICES[0].id);
  const [engine, setEngine] = useState('edge');
  const fileInputRef = useRef(null);
  const [fileName, setFileName] = useState(null);

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
    const file = fileInputRef.current?.files?.[0];
    if (!file) return setError('Pick a video file first');
    setError(null); setBusy(true);
    try {
      const form = new FormData();
      form.append('video', file);
      const res = await fetch(`/api/projects/${id}/video-source`, { method: 'POST', body: form });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      setFileName(file.name);
      await reload();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function runAnalyze() {
    setError(null); setBusy(true);
    try {
      await post(`/projects/${id}/video-summary/run`, { duration: Number(duration) });
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
      await post(`/projects/${id}/render`, { duration: Number(duration) });
      await reload();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const state = project?.state || {};
  const sourceUploaded = state.upload === 'complete' || fileName;
  const analysisDone = state.script === 'complete';
  const voiceDone    = state.voice === 'complete';
  const renderDone   = state.render === 'complete';

  return (
    <div style={styles.page} className="fade-in">
      <div style={styles.title}>{project?.name || 'Video Summary'}</div>

      {error && <div style={styles.errorBanner}>{error}</div>}
      {progress && progress.percent >= 0 && (
        <div style={styles.card}>
          <div style={styles.step}>{progress.step}</div>
          <div style={styles.progress}>{progress.message}</div>
          <div style={styles.bar}><div style={{ ...styles.barFill, width: `${Math.max(0, Math.min(100, progress.percent))}%` }} /></div>
        </div>
      )}

      <div style={styles.card}>
        <div style={styles.step}>1 · Source video</div>
        {sourceUploaded ? (
          <div style={styles.progress}>✓ Source video uploaded ({fileName || 'source.mp4'})</div>
        ) : (
          <form onSubmit={handleUpload} style={styles.row}>
            <input type="file" accept="video/mp4,video/x-matroska,video/quicktime,video/webm" ref={fileInputRef} />
            <button type="submit" className="btn-primary" disabled={busy}>Upload</button>
          </form>
        )}
      </div>

      <div style={styles.card}>
        <div style={styles.step}>2 · Analyze + generate script</div>
        <div style={styles.row}>
          <div style={styles.field}>
            <label>Target reel duration (seconds)</label>
            <input type="number" min="30" max="900" value={duration} onChange={e => setDuration(e.target.value)} />
          </div>
          <button className="btn-primary" onClick={runAnalyze} disabled={busy || !sourceUploaded}>
            {analysisDone ? 'Re-run analysis' : 'Run analysis'}
          </button>
        </div>
        {analysisDone && <div style={styles.progress}>✓ Analysis + script complete</div>}
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
          <button className="btn-primary" onClick={generateVoice} disabled={busy || !analysisDone}>
            {voiceDone ? 'Re-generate' : 'Generate'}
          </button>
        </div>
        {voiceDone && <div style={styles.progress}>✓ Narration ready</div>}
      </div>

      <div style={styles.card}>
        <div style={styles.step}>4 · Render</div>
        <div style={styles.row}>
          <button className="btn-primary" onClick={renderVideo} disabled={busy || !voiceDone}>
            {renderDone ? 'Re-render' : 'Render final video'}
          </button>
          {renderDone && (
            <a className="btn-secondary" href={`/api/projects/${id}/download`} download>Download</a>
          )}
        </div>
      </div>
    </div>
  );
}
