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
  field: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 120 },
  errorBanner: {
    padding: '12px 16px', background: 'rgba(239,68,68,0.10)',
    border: '1px solid rgba(239,68,68,0.30)', borderRadius: 8,
    color: 'var(--error)', fontSize: 13,
  },
  clipGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: 16,
  },
  clipCard: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--glass-border)',
    borderRadius: 12,
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  clipTitle: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  clipMeta: { fontSize: 12, color: 'var(--text-muted)' },
  clipReason: { fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic' },
  badge: {
    display: 'inline-block', fontSize: 11, fontWeight: 600, padding: '2px 8px',
    borderRadius: 4, background: 'rgba(139,92,246,0.15)', color: 'var(--accent-purple)',
  },
  checkbox: {
    width: 18, height: 18, accentColor: 'var(--accent-purple)', cursor: 'pointer',
  },
  checkboxLabel: {
    display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12,
    color: 'var(--text-secondary)',
  },
  selectionBar: {
    display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
  },
  selectionBtn: {
    fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
    border: '1px solid var(--glass-border)', background: 'transparent',
    color: 'var(--text-secondary)',
  },
  translateOneBtn: {
    fontSize: 11, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
    border: '1px solid rgba(139,92,246,0.3)', background: 'rgba(139,92,246,0.1)',
    color: 'var(--accent-purple)', fontWeight: 600,
  },
  textarea: {
    width: '100%', minHeight: 80, padding: 8, fontSize: 13,
    fontFamily: 'inherit', borderRadius: 8, border: '1px solid var(--glass-border)',
    background: 'var(--bg-primary)', color: 'var(--text-primary)', resize: 'vertical',
  },
  originalText: {
    fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic',
    background: 'rgba(0,0,0,0.1)', padding: 8, borderRadius: 6,
    maxHeight: 100, overflow: 'auto', whiteSpace: 'pre-wrap',
  },
};

function stepStatus(state, step) {
  const s = state?.[step];
  if (s === 'error') return 'error';
  if (s === 'complete') return 'done';
  if (s === 'processing') return 'active';
  return 'pending';
}

function stepText(status, labels) {
  if (status === 'error') return labels.error || 'Failed';
  if (status === 'done') return labels.done || 'Done';
  if (status === 'active') return labels.active || 'Processing...';
  return labels.pending || 'Waiting...';
}

export default function ShortsPage() {
  const { id } = useParams();
  const progress = useSSE(id);
  const [project, setProject] = useState(null);
  const [clips, setClips] = useState(null);
  const [translatedClips, setTranslatedClips] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [voiceId, setVoiceId] = useState('en-US-GuyNeural');
  const [engine, setEngine] = useState('edge');
  const [translateMode, setTranslateMode] = useState('ai');
  const [sourceVolume, setSourceVolume] = useState(5);
  const [clipTranscripts, setClipTranscripts] = useState(null);
  const [manualScripts, setManualScripts] = useState({});
  const [selectedClips, setSelectedClips] = useState(new Set());

  // Settings for re-detect
  const [clipCount, setClipCount] = useState(5);
  const [clipDuration, setClipDuration] = useState(60);
  const [aspect, setAspect] = useState('9:16');
  const [subtitles, setSubtitles] = useState(true);

  useEffect(() => {
    reload();
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [id]);

  async function reload() {
    try {
      const p = await get(`/projects/${id}`);
      setProject(p);
      if (p.config) {
        setClipCount(p.config.clipCount || 5);
        setClipDuration(p.config.clipDuration || 60);
        setAspect(p.config.aspect || '9:16');
        setSubtitles(p.config.subtitles !== false);
      }
      if (p.state?.render === 'complete') {
        try { setClips(await get(`/shorts/${id}/clips`)); } catch {}
      }
      if (p.state?.voice === 'complete') {
        try { setTranslatedClips(await get(`/shorts/${id}/translated-clips`)); } catch {}
      }
    } catch (e) { setError(e.message); }
  }

  async function retryFromTranscript() {
    setError(null); setBusy(true);
    try {
      await post(`/shorts/${id}/retry`);
      await reload();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function redetect() {
    setError(null); setBusy(true);
    try {
      await post(`/shorts/${id}/redetect`, { clipCount, clipDuration, aspect, subtitles });
      setClips(null);
      setTranslatedClips(null);
      setClipTranscripts(null);
      setManualScripts({});
      await reload();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function loadTranscripts() {
    try {
      const t = await get(`/shorts/${id}/clip-transcripts`);
      setClipTranscripts(t);
    } catch (e) { setError(e.message); }
  }

  async function translateClips(overrideIndices) {
    setError(null); setBusy(true);
    try {
      const body = {
        engine,
        sourceVolume: sourceVolume / 100,
      };
      // Only send voiceId for Edge TTS; ElevenLabs uses .env voice
      if (engine === 'edge') body.voiceId = voiceId;
      // Determine which clips to translate
      const indices = overrideIndices || (selectedClips.size > 0 ? [...selectedClips] : null);
      if (indices && indices.length > 0) {
        body.clipIndices = indices;
      }
      if (translateMode === 'manual') {
        body.scripts = Object.entries(manualScripts)
          .filter(([, script]) => script.trim())
          .map(([clipIndex, script]) => ({ clipIndex: Number(clipIndex), script }));
      }
      await post(`/shorts/${id}/translate-clips`, body);
      await reload();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  function toggleClip(i) {
    setSelectedClips(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  function selectAllClips() {
    if (clips) setSelectedClips(new Set(clips.map((_, i) => i)));
  }

  function deselectAllClips() {
    setSelectedClips(new Set());
  }

  function updateScript(clipIndex, text) {
    setManualScripts(prev => ({ ...prev, [clipIndex]: text }));
  }

  const state = project?.state || {};
  const errored = (project?.errors || []).slice(-1)[0];
  const allDone = state.render === 'complete';

  // Load transcripts when switching to manual mode
  useEffect(() => {
    if (translateMode === 'manual' && allDone && !clipTranscripts) {
      loadTranscripts();
    }
  }, [translateMode, allDone]);

  return (
    <div style={styles.page} className="fade-in">
      <div style={styles.title}>{project?.name || 'YouTube Shorts'}</div>

      {error && <div style={styles.errorBanner}>{error}</div>}
      {errored && <div style={styles.errorBanner}>Last error ({errored.step}): {errored.message}</div>}

      {progress && progress.percent === -1 && (
        <div style={styles.errorBanner}>{progress.message}</div>
      )}
      {progress && progress.percent >= 0 && (
        <div style={styles.card}>
          <div style={styles.step}>{progress.step}</div>
          <div style={styles.progress}>{progress.message}</div>
          <div style={styles.bar}>
            <div style={{ ...styles.barFill, width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
          </div>
        </div>
      )}

      {/* Pipeline steps */}
      <div style={styles.card}>
        <div style={styles.step}>1 · Download from YouTube</div>
        <div style={styles.progress}>
          {stepText(stepStatus(state, 'upload'), {
            done: `Downloaded (${((project?.stats?.videoDurationSec || 0) / 60).toFixed(1)} min)`,
            active: 'Downloading via yt-dlp...',
            error: 'Download failed',
            pending: 'Waiting...',
          })}
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.step}>2 · Transcribe audio</div>
        <div style={styles.progress}>
          {stepText(stepStatus(state, 'panels'), {
            done: 'Transcript ready',
            active: 'Transcribing audio...',
            error: 'Transcription failed',
          })}
        </div>
        {state.panels === 'error' && state.upload === 'complete' && (
          <button className="btn-primary" onClick={retryFromTranscript}
            disabled={busy} style={{ alignSelf: 'flex-start', fontSize: 12, padding: '6px 14px' }}>
            Retry transcription
          </button>
        )}
      </div>

      <div style={styles.card}>
        <div style={styles.step}>3 · AI finds interesting moments</div>
        <div style={styles.progress}>
          {stepText(stepStatus(state, 'script'), {
            done: `Found ${project?.stats?.panelCount || '?'} clips`,
            active: 'Analyzing transcript for viral moments...',
            error: 'Detection failed',
          })}
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.step}>4 · Render clips</div>
        <div style={styles.progress}>
          {stepText(stepStatus(state, 'render'), {
            done: `${clips?.length || '?'} clips ready`,
            active: 'Rendering clips...',
            error: 'Render failed',
          })}
        </div>
      </div>

      {/* Settings + Re-detect */}
      {state.panels === 'complete' && (
        <div style={styles.card}>
          <div style={styles.step}>Settings</div>
          <div style={styles.row}>
            <div style={styles.field}>
              <label>Clips</label>
              <input type="number" min="1" max="20" value={clipCount}
                onChange={e => setClipCount(+e.target.value)} />
            </div>
            <div style={styles.field}>
              <label>Duration (sec)</label>
              <input type="number" min="15" max="180" value={clipDuration}
                onChange={e => setClipDuration(+e.target.value)} />
            </div>
            <div style={styles.field}>
              <label>Aspect</label>
              <select value={aspect} onChange={e => setAspect(e.target.value)}>
                <option value="9:16">9:16 (Reels)</option>
                <option value="1:1">1:1 (Square)</option>
                <option value="16:9">16:9 (Landscape)</option>
              </select>
            </div>
            <div style={styles.field}>
              <label>Subtitles</label>
              <select value={subtitles ? 'yes' : 'no'} onChange={e => setSubtitles(e.target.value === 'yes')}>
                <option value="yes">Original language subs</option>
                <option value="no">No subtitles</option>
              </select>
            </div>
          </div>
          <div>
            <button className="btn-primary" onClick={redetect} disabled={busy || state.render === 'processing'}>
              {allDone ? 'Re-generate clips' : 'Generate clips'}
            </button>
          </div>
        </div>
      )}

      {/* Clip results */}
      {clips && clips.length > 0 && (
        <>
          <div style={{ ...styles.step, fontSize: 14 }}>Generated Clips (Original)</div>
          <div style={styles.clipGrid}>
            {clips.map((clip, i) => (
              <div key={i} style={{
                ...styles.clipCard,
                ...(selectedClips.has(i) ? { borderColor: 'var(--accent-purple)', boxShadow: '0 0 0 1px var(--accent-purple)' } : {}),
              }}>
                <div style={styles.row}>
                  <label style={styles.checkboxLabel}>
                    <input type="checkbox" style={styles.checkbox}
                      checked={selectedClips.has(i)}
                      onChange={() => toggleClip(i)} />
                  </label>
                  <span style={styles.badge}>#{i + 1}</span>
                  <span style={styles.clipMeta}>{clip.durationSec}s</span>
                  <span style={styles.clipMeta}>
                    {Math.floor(clip.startSec / 60)}:{String(Math.floor(clip.startSec % 60)).padStart(2, '0')}
                    {' - '}
                    {Math.floor(clip.endSec / 60)}:{String(Math.floor(clip.endSec % 60)).padStart(2, '0')}
                  </span>
                </div>
                <div style={styles.clipTitle}>{clip.title}</div>
                <div style={styles.clipReason}>{clip.reason}</div>
                <div style={styles.row}>
                  <a className="btn-primary"
                    href={`/api/shorts/${id}/clips/${i}/download`}
                    download
                    style={{ textDecoration: 'none', fontSize: 12, padding: '6px 14px' }}
                  >
                    Download
                  </a>
                  <button style={styles.translateOneBtn}
                    disabled={busy || state.voice === 'processing'}
                    onClick={() => translateClips([i])}
                  >
                    Translate this clip
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Translate + Voiceover */}
      {allDone && (
        <div style={styles.card}>
          <div style={styles.step}>Translate + English Voiceover (optional)</div>
          <div style={styles.progress}>
            {state.voice === 'complete'
              ? `${translatedClips?.length || '?'} translated clips ready`
              : state.voice === 'processing'
              ? 'Translating & generating voiceover...'
              : state.voice === 'error'
              ? 'Translation failed'
              : 'Generate English-narrated versions of all clips'}
          </div>
          <div style={styles.row}>
            <div style={styles.field}>
              <label>Translation mode</label>
              <select value={translateMode} onChange={e => setTranslateMode(e.target.value)}>
                <option value="ai">AI translate</option>
                <option value="manual">Manual script</option>
              </select>
            </div>
            <div style={styles.field}>
              <label>Engine</label>
              <select value={engine} onChange={e => setEngine(e.target.value)}>
                <option value="edge">Edge TTS (free)</option>
                <option value="elevenlabs">ElevenLabs</option>
              </select>
            </div>
            {engine === 'edge' && (
              <div style={styles.field}>
                <label>Voice</label>
                <select value={voiceId} onChange={e => setVoiceId(e.target.value)}>
                  <option value="en-US-GuyNeural">Guy - Deep Male</option>
                  <option value="en-US-AriaNeural">Aria - Versatile Female</option>
                  <option value="en-US-ChristopherNeural">Christopher - Authoritative</option>
                </select>
              </div>
            )}
            <div style={{ ...styles.field, minWidth: 100, maxWidth: 140 }}>
              <label>Hindi vol ({sourceVolume}%)</label>
              <input type="range" min="0" max="30" value={sourceVolume}
                onChange={e => setSourceVolume(+e.target.value)} />
            </div>
          </div>

          {/* Manual script textareas per clip */}
          {translateMode === 'manual' && clipTranscripts && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 8 }}>
              {clipTranscripts.map((ct) => (
                <div key={ct.clipIndex} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                    Clip {ct.clipIndex + 1}: {ct.title}
                  </div>
                  <div style={styles.originalText}>
                    {ct.originalText || '(no transcript text)'}
                  </div>
                  <textarea
                    style={styles.textarea}
                    placeholder={`Paste/write English script for clip ${ct.clipIndex + 1}... (leave empty to use AI translation)`}
                    value={manualScripts[ct.clipIndex] || ''}
                    onChange={e => updateScript(ct.clipIndex, e.target.value)}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Progress bar when translating */}
          {state.voice === 'processing' && progress?.step === 'voice' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 12, color: 'var(--accent-purple)', fontWeight: 600 }}>
                ⏳ {progress.message || 'Translating...'}
              </div>
              <div style={styles.bar}>
                <div style={{ ...styles.barFill, width: `${Math.max(0, Math.min(100, progress.percent || 0))}%` }} />
              </div>
            </div>
          )}

          <div style={styles.selectionBar}>
            <button className="btn-primary" onClick={() => translateClips()}
              disabled={busy || state.voice === 'processing'}>
              {(busy || state.voice === 'processing')
                ? '⏳ Translating...'
                : selectedClips.size > 0
                ? `Translate ${selectedClips.size} selected clip${selectedClips.size > 1 ? 's' : ''}`
                : state.voice === 'complete' ? 'Re-translate All' : 'Translate All Clips'}
            </button>
            {clips && clips.length > 1 && (
              <>
                <button style={styles.selectionBtn} onClick={selectAllClips}>Select All</button>
                <button style={styles.selectionBtn} onClick={deselectAllClips}>Deselect All</button>
              </>
            )}
            {selectedClips.size > 0 && !(busy || state.voice === 'processing') && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {selectedClips.size} of {clips?.length || 0} selected
              </span>
            )}
          </div>
        </div>
      )}

      {/* Translated clip results */}
      {translatedClips && translatedClips.length > 0 && (
        <>
          <div style={{ ...styles.step, fontSize: 14 }}>Translated Clips (English)</div>
          <div style={styles.clipGrid}>
            {translatedClips.map((clip, i) => (
              <div key={i} style={{ ...styles.clipCard, borderColor: 'rgba(139,92,246,0.3)' }}>
                <div style={styles.row}>
                  <span style={{ ...styles.badge, background: 'rgba(16,185,129,0.15)', color: 'var(--success)' }}>EN #{i + 1}</span>
                  <span style={styles.clipMeta}>{clip.durationSec}s</span>
                </div>
                <div style={styles.clipTitle}>{clip.title}</div>
                <div style={styles.row}>
                  <a className="btn-primary"
                    href={`/api/shorts/${id}/translated-clips/${i}/download`}
                    download
                    style={{ textDecoration: 'none', fontSize: 12, padding: '6px 14px' }}
                  >
                    Download (EN)
                  </a>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
