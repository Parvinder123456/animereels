import React, { useEffect, useState } from 'react';
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
  bar: { height: 6, borderRadius: 999, background: 'var(--glass-border)', overflow: 'hidden' },
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
  { id: 'en-US-AriaNeural',        label: 'Aria — Versatile Female' },
  { id: 'en-US-ChristopherNeural', label: 'Christopher — Authoritative' },
];

export default function TranslatePage() {
  const { id } = useParams();
  const progress = useSSE(id);
  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [voiceId, setVoiceId] = useState(VOICES[0].id);
  const [engine, setEngine] = useState('edge');

  useEffect(() => {
    reload();
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [id]);

  async function reload() {
    try { setProject(await get(`/projects/${id}`)); }
    catch (e) { setError(e.message); }
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
      await post(`/projects/${id}/render`, {});
      await reload();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const state = project?.state || {};
  const downloadDone   = state.upload === 'complete';
  const transcriptDone = state.panels === 'complete';
  const scriptDone     = state.script === 'complete';
  const voiceDone      = state.voice === 'complete';
  const renderDone     = state.render === 'complete';
  const errored        = (project?.errors || []).slice(-1)[0];

  return (
    <div style={styles.page} className="fade-in">
      <div style={styles.title}>{project?.name || 'YouTube Hindi → English'}</div>

      {error && <div style={styles.errorBanner}>{error}</div>}
      {errored && <div style={styles.errorBanner}>Last error: {errored.message}</div>}

      {progress && progress.percent >= 0 && (
        <div style={styles.card}>
          <div style={styles.step}>{progress.step}</div>
          <div style={styles.progress}>{progress.message}</div>
          <div style={styles.bar}><div style={{ ...styles.barFill, width: `${Math.max(0, Math.min(100, progress.percent))}%` }} /></div>
        </div>
      )}

      <div style={styles.card}>
        <div style={styles.step}>1 · Download from YouTube</div>
        <div style={styles.progress}>{downloadDone ? '✓ Source downloaded' : 'Downloading via yt-dlp…'}</div>
      </div>

      <div style={styles.card}>
        <div style={styles.step}>2 · Whisper transcribe + topic match</div>
        <div style={styles.progress}>{transcriptDone ? '✓ Transcript + window selected' : 'Transcribing audio with Whisper…'}</div>
      </div>

      <div style={styles.card}>
        <div style={styles.step}>3 · Translate to English (DeepSeek)</div>
        <div style={styles.progress}>{scriptDone ? '✓ Translation written to script.json' : 'Translating segments…'}</div>
      </div>

      <div style={styles.card}>
        <div style={styles.step}>4 · Generate English narration</div>
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
          <button className="btn-primary" onClick={generateVoice} disabled={busy || !scriptDone}>
            {voiceDone ? 'Re-generate' : 'Generate'}
          </button>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.step}>5 · Render final clip</div>
        <div style={styles.row}>
          <button className="btn-primary" onClick={renderVideo} disabled={busy || !voiceDone}>
            {renderDone ? 'Re-render' : 'Render'}
          </button>
          {renderDone && (
            <a className="btn-secondary" href={`/api/projects/${id}/download`} download>Download</a>
          )}
        </div>
      </div>
    </div>
  );
}
