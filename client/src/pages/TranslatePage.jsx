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

const HINDI_PROMPT = `Transcribe the attached audio. Return ONLY valid JSON in this shape, no prose, no code fence:

{
  "language": "hi",
  "duration": <total seconds, number>,
  "segments": [
    { "id": 0, "start": <sec>, "end": <sec>, "text": "<verbatim transcript>" },
    { "id": 1, "start": <sec>, "end": <sec>, "text": "..." }
  ]
}

Rules: break at natural pauses (5-15s per segment), cover the whole audio, transcribe verbatim in the original language, do not translate.`;

const ENGLISH_PROMPT = `Listen to the attached audio (Hindi or Hinglish) and produce a tight English narration script that summarizes what is said in roughly the same spoken length (~2.3 words/sec). Return ONLY valid JSON in this shape, no prose, no code fence:

{
  "title": "<short English title>",
  "hook":  "<one-sentence English hook>",
  "segments": [
    { "text": "<English line>", "mood": "calm|dramatic|emotional|comedic|reveal|suspense" },
    { "text": "...",            "mood": "..." }
  ]
}

Rules: 1 segment per ~10 seconds of audio, in chronological order. Idiomatic English — do not transliterate. Mood reflects the speaker's tone in that part. Output ONLY the JSON object.`;

export default function TranslatePage() {
  const { id } = useParams();
  const progress = useSSE(id);
  const [project, setProject] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [voiceId, setVoiceId] = useState(VOICES[0].id);
  const [engine, setEngine] = useState('edge');
  const [aspect, setAspect] = useState('9:16');
  const [transcriptText, setTranscriptText] = useState('');
  const [manualMode, setManualMode] = useState('english'); // 'hindi' | 'english'
  const [windowStart, setWindowStart] = useState(0);
  const [windowEnd, setWindowEnd] = useState(180);

  useEffect(() => {
    reload();
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [id]);

  async function reload() {
    try { setProject(await get(`/projects/${id}`)); }
    catch (e) { setError(e.message); }
  }

  async function submitManual() {
    if (!transcriptText.trim()) return setError('Paste your transcript or script first');
    setError(null); setBusy(true);
    try {
      if (manualMode === 'english') {
        await post(`/translate/${id}/manual-script`, {
          script: transcriptText,
          startSec: Number(windowStart) || 0,
          endSec:   Number(windowEnd)   || 180,
        });
      } else {
        await post(`/translate/${id}/manual-transcript`, { transcript: transcriptText, format: 'auto' });
      }
      await reload();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  function copyPrompt() {
    const prompt = manualMode === 'english' ? ENGLISH_PROMPT : HINDI_PROMPT;
    navigator.clipboard?.writeText(prompt).catch(() => {});
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
  const isManual       = project?.config?.transcribeMode === 'manual';
  const downloadDone   = state.upload === 'complete';
  const audioReady     = downloadDone && (isManual ? state.panels !== 'pending' : true);
  const transcriptDone = state.panels === 'complete';
  const scriptDone     = state.script === 'complete';
  const voiceDone      = state.voice === 'complete';
  const renderDone     = state.render === 'complete';
  const errored        = (project?.errors || []).slice(-1)[0];
  const manualPending  = isManual && audioReady && !scriptDone;

  return (
    <div style={styles.page} className="fade-in">
      <div style={styles.title}>{project?.name || 'YouTube Hindi → English'}</div>

      {error && <div style={styles.errorBanner}>{error}</div>}
      {errored && <div style={styles.errorBanner}>Last error ({errored.step}): {errored.message}</div>}
      {progress && progress.percent === -1 && (
        <div style={styles.errorBanner}>{progress.message}</div>
      )}

      {progress && progress.percent >= 0 && (
        <div style={styles.card}>
          <div style={styles.step}>{progress.step}</div>
          <div style={styles.progress}>{progress.message}</div>
          <div style={styles.bar}><div style={{ ...styles.barFill, width: `${Math.max(0, Math.min(100, progress.percent))}%` }} /></div>
        </div>
      )}

      <div style={styles.card}>
        <div style={styles.step}>1 · Download from YouTube</div>
        <div style={styles.progress}>
          {state.upload === 'error' ? '✗ Download failed — check server logs'
           : downloadDone ? '✓ Source downloaded'
           : 'Downloading via yt-dlp…'}
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.step}>2 · {isManual ? 'Paste transcript (free path)' : 'Transcribe + topic match'}</div>
        {!isManual && (
          <div style={styles.progress}>
            {state.panels === 'error' ? '✗ Transcription failed — check server logs'
             : transcriptDone ? '✓ Transcript + window selected'
             : 'Transcribing audio…'}
          </div>
        )}
        {isManual && (
          <>
            <div style={styles.progress}>
              {audioReady
                ? '✓ Audio extracted. Download it, run it through Gemini mobile (or any source), paste the transcript below.'
                : 'Downloading + extracting audio…'}
            </div>
            {audioReady && (
              <>
                <div style={styles.row}>
                  <a className="btn-secondary" href={`/data/${id}/audio/source-audio.mp3`} download>
                    Download source-audio.mp3
                  </a>
                  <button type="button" className="btn-secondary" onClick={copyPrompt}>
                    Copy Gemini prompt
                  </button>
                </div>
                <details style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  <summary style={{ cursor: 'pointer' }}>How to use Gemini mobile</summary>
                  <ol style={{ paddingLeft: 18, lineHeight: 1.6 }}>
                    <li>Download the audio file above onto your phone.</li>
                    <li>Open the Gemini mobile app, attach the audio.</li>
                    <li>Paste the prompt (button above) and send.</li>
                    <li>Copy Gemini's full reply (JSON) and paste it below.</li>
                    <li>Plain text also works — we'll auto-distribute timestamps.</li>
                  </ol>
                </details>
                {!scriptDone && (
                  <>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => setManualMode('english')}
                        style={{
                          flex: 1, padding: '8px 12px', borderRadius: 8,
                          border: `1px solid ${manualMode === 'english' ? 'var(--accent-purple)' : 'var(--glass-border)'}`,
                          background: manualMode === 'english' ? 'rgba(139,92,246,0.10)' : 'transparent',
                          color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12,
                        }}
                      >
                        Paste English script (zero API calls)
                      </button>
                      <button
                        type="button"
                        onClick={() => setManualMode('hindi')}
                        style={{
                          flex: 1, padding: '8px 12px', borderRadius: 8,
                          border: `1px solid ${manualMode === 'hindi' ? 'var(--accent-purple)' : 'var(--glass-border)'}`,
                          background: manualMode === 'hindi' ? 'rgba(139,92,246,0.10)' : 'transparent',
                          color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12,
                        }}
                      >
                        Paste Hindi transcript (uses DeepSeek to translate)
                      </button>
                    </div>
                    {manualMode === 'english' && (
                      <div style={styles.row}>
                        <div style={styles.field}>
                          <label>Source window start (sec)</label>
                          <input type="number" min="0" value={windowStart} onChange={e => setWindowStart(e.target.value)} />
                        </div>
                        <div style={styles.field}>
                          <label>Source window end (sec)</label>
                          <input type="number" min="1" value={windowEnd} onChange={e => setWindowEnd(e.target.value)} />
                        </div>
                      </div>
                    )}
                    <textarea
                      rows={8}
                      placeholder={manualMode === 'english'
                        ? 'Paste English script JSON: { "title":..., "hook":..., "segments":[{"text":..., "mood":...}] }  — or plain English text'
                        : 'Paste Hindi transcript JSON, or plain Hindi text…'}
                      value={transcriptText}
                      onChange={e => setTranscriptText(e.target.value)}
                      style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
                    />
                    <div style={styles.row}>
                      <button className="btn-primary" onClick={submitManual} disabled={busy || !transcriptText.trim()}>
                        Submit
                      </button>
                    </div>
                  </>
                )}
                {scriptDone && <div style={styles.progress}>✓ Transcript accepted, translation written</div>}
              </>
            )}
          </>
        )}
      </div>

      <div style={styles.card}>
        <div style={styles.step}>
          3 · {isManual && manualMode === 'english' ? 'English script (no API)' : 'Translate to English (DeepSeek)'}
        </div>
        <div style={styles.progress}>
          {state.script === 'error' ? '✗ Translation failed — check server logs'
           : scriptDone ? '✓ Script written'
           : (manualPending ? 'Waiting for transcript / script paste above…' : 'Translating segments…')}
        </div>
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
          <div style={styles.field}>
            <label>Aspect ratio</label>
            <select value={aspect} onChange={e => setAspect(e.target.value)}>
              <option value="9:16">9:16 (Reels / Shorts)</option>
              <option value="1:1">1:1 (Square)</option>
              <option value="16:9">16:9 (Landscape)</option>
              <option value="original">Original</option>
            </select>
          </div>
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
