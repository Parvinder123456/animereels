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
  const [skipWindowsText, setSkipWindowsText] = useState('');
  const fileInputRef = useRef(null);
  const [fileNames, setFileNames] = useState([]);
  const [preview, setPreview] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [expandedScenes, setExpandedScenes] = useState(new Set());

  useEffect(() => {
    reload();
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [id]);

  // Prefill skip-windows textarea from persisted project config once it loads.
  useEffect(() => {
    const saved = project?.config?.manualSkipWindows;
    if (Array.isArray(saved) && saved.length && !skipWindowsText) {
      setSkipWindowsText(saved.map(w => `${fmtTime(w.startSec)}-${fmtTime(w.endSec)}`).join('\n'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.config?.manualSkipWindows]);

  async function reload() {
    try { setProject(await get(`/projects/${id}`)); }
    catch (e) { setError(e.message); }
  }

  async function loadPreview() {
    try { setPreview(await get(`/projects/${id}/explainer/preview`)); }
    catch (e) { /* preview unavailable until analysis completes; ignore */ }
  }

  // Auto-load preview when analysis finishes (state.script flips to complete).
  useEffect(() => {
    if (project?.state?.script === 'complete') loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.state?.script, project?.updatedAt]);

  function toggleScene(idx) {
    setExpandedScenes(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }

  async function regenerateScript() {
    setError(null); setBusy(true);
    try {
      // force=false keeps scene-plan/bundle/op-ed caches; only selection + script re-run.
      await post(`/projects/${id}/explainer/run`, {
        targetDurationSec: Math.max(60, Number(targetMinutes) * 60),
        language: 'en',
        force: false,
        manualSkipWindows: skipWindowsText.trim(),
      });
      await reload();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
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
        manualSkipWindows: skipWindowsText.trim(),
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
        <div style={styles.field}>
          <label>Manual skip windows (one per line)</label>
          <textarea
            rows={4}
            placeholder={`# Format: M:SS-M:SS or H:MM:SS-H:MM:SS or seconds\n0:00-1:30\n22:00-24:00`}
            value={skipWindowsText}
            onChange={e => setSkipWindowsText(e.target.value)}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.4 }}
          />
          <div style={styles.hint}>
            Time ranges (in the stitched timeline) that should be cut from the output. Use this when
            OP/ED auto-detection misses a cold open, mid-episode recap, or ED that doesn't sit at
            the exact episode boundary. Merged with auto-detected OP/ED. Lines starting with <code>#</code> are ignored.
          </div>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={forceRefresh} onChange={e => setForceRefresh(e.target.checked)} />
          Force re-run from scratch (skip scene-plan + OP/ED cache — costs ~$0.90 in Gemini if free tier is exhausted)
        </label>
        <div style={styles.hint}>
          By default, re-running with the same source skips the Gemini multimodal breakdown
          (the most expensive step). Only the scene-selection + script-writer steps re-run.
          Changing the skip windows above does NOT require force — they're applied dynamically
          on top of the cached scene plan.
        </div>
        {analyzeDone && <div style={styles.progress}>✓ Script + scenes ready</div>}
      </div>

      {analyzeDone && preview && (
        <div style={styles.card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={styles.step}>Analysis preview — what the narrator will say + what scenes will play</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn-secondary" onClick={regenerateScript} disabled={busy}>
                Re-generate script (keep scene plan)
              </button>
              <button type="button" className="btn-secondary" onClick={() => setPreviewOpen(o => !o)}>
                {previewOpen ? 'Collapse' : 'Expand'}
              </button>
            </div>
          </div>

          {previewOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{preview.title || '(untitled)'}</div>
                {preview.hook && <div style={{ fontStyle: 'italic', color: 'var(--text-secondary)', marginTop: 4 }}>"{preview.hook}"</div>}
              </div>

              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-muted)' }}>
                <span>{preview.stats.sceneCount} scenes</span>
                <span>{preview.stats.totalWords} words</span>
                {preview.stats.mode && <span>mode: {preview.stats.mode}</span>}
                {preview.stats.sourceDurationSec && <span>source: {fmtTime(preview.stats.sourceDurationSec)}</span>}
                {preview.stats.targetDurationSec && <span>target: {fmtTime(preview.stats.targetDurationSec)}</span>}
                {preview.stats.coveredDurationSec > 0 && <span>covered: {fmtTime(preview.stats.coveredDurationSec)}</span>}
              </div>

              {preview.bundle && (
                <details>
                  <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)' }}>
                    Story arc + characters (the narrator's full context)
                  </summary>
                  <div style={{ padding: '8px 0', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                    {preview.bundle.arcSummary && (
                      <div><strong>Arc:</strong> {preview.bundle.arcSummary}</div>
                    )}
                    {Array.isArray(preview.bundle.characters) && preview.bundle.characters.length > 0 && (
                      <div>
                        <strong>Characters:</strong>
                        <ul style={{ marginTop: 4, paddingLeft: 18, lineHeight: 1.5 }}>
                          {preview.bundle.characters.map((c, i) => (
                            <li key={i}><strong>{c.name}:</strong> {c.role}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {Array.isArray(preview.bundle.episodeRecap) && preview.bundle.episodeRecap.length > 0 && (
                      <div>
                        <strong>Episode recap:</strong>
                        <ul style={{ marginTop: 4, paddingLeft: 18, lineHeight: 1.5 }}>
                          {preview.bundle.episodeRecap.map((e, i) => (
                            <li key={i}>Ep {e.episodeIdx + 1} — {e.title}: {e.oneLine}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {Array.isArray(preview.bundle.throughLines) && preview.bundle.throughLines.length > 0 && (
                      <div><strong>Through lines:</strong> {preview.bundle.throughLines.join('; ')}</div>
                    )}
                    {preview.bundle.endsOn && <div><strong>Ends on:</strong> {preview.bundle.endsOn}</div>}
                  </div>
                </details>
              )}

              {((preview.skipWindows.op?.length || 0) + (preview.skipWindows.ed?.length || 0) + (preview.skipWindows.manual?.length || 0)) > 0 && (
                <details>
                  <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)' }}>
                    Skip windows applied ({(preview.skipWindows.op?.length || 0) + (preview.skipWindows.ed?.length || 0)} auto + {preview.skipWindows.manual?.length || 0} manual)
                  </summary>
                  <div style={{ padding: '8px 0', fontSize: 12, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                    {(preview.skipWindows.op || []).map((w, i) => <div key={`op-${i}`}>OP  {fmtTime(w.startSec)}–{fmtTime(w.endSec)}</div>)}
                    {(preview.skipWindows.ed || []).map((w, i) => <div key={`ed-${i}`}>ED  {fmtTime(w.startSec)}–{fmtTime(w.endSec)}</div>)}
                    {(preview.skipWindows.manual || []).map((w, i) => <div key={`m-${i}`}>MAN {fmtTime(w.startSec)}–{fmtTime(w.endSec)}</div>)}
                  </div>
                </details>
              )}

              <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: 12 }}>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  Per-scene breakdown ({preview.scenes.length}) — click a row to expand
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 600, overflowY: 'auto', paddingRight: 4 }}>
                  {preview.scenes.map(sc => {
                    const isOpen = expandedScenes.has(sc.sceneIndex);
                    return (
                      <div key={sc.sceneIndex} style={{
                        border: '1px solid var(--glass-border)', borderRadius: 6,
                        padding: '8px 12px', background: 'rgba(255,255,255,0.02)',
                      }}>
                        <div
                          onClick={() => toggleScene(sc.sceneIndex)}
                          style={{ cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'center', fontSize: 12 }}
                        >
                          <span style={{ color: 'var(--text-muted)', minWidth: 28, textAlign: 'right' }}>#{sc.sceneIndex}</span>
                          <span style={{ color: 'var(--text-muted)', fontFamily: 'monospace', minWidth: 110 }}>
                            {fmtTime(sc.sourceStart)}–{fmtTime(sc.sourceEnd)}
                          </span>
                          <span style={{ color: 'var(--text-muted)', minWidth: 40 }}>{Math.round(sc.durationSec)}s</span>
                          {sc.mood && <span style={{ color: 'var(--accent-purple)', minWidth: 70 }}>{sc.mood}</span>}
                          <span style={{ flex: 1, color: 'var(--text-primary)' }}>
                            {(sc.narration || '').slice(0, 110)}{(sc.narration || '').length > 110 ? '…' : ''}
                          </span>
                          <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{isOpen ? '▼' : '▶'}</span>
                        </div>
                        {isOpen && (
                          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--glass-border)', fontSize: 12, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {sc.visualDescription && <div><strong style={{ color: 'var(--accent-cyan)' }}>VISUAL:</strong> {sc.visualDescription}</div>}
                            {sc.dialogueGist && <div><strong style={{ color: 'var(--accent-cyan)' }}>SAYS:</strong> {sc.dialogueGist}</div>}
                            {sc.dialogueVerbatim && <div><strong style={{ color: 'var(--accent-cyan)' }}>VERBATIM:</strong> {sc.dialogueVerbatim}</div>}
                            {Array.isArray(sc.characters) && sc.characters.length > 0 && (
                              <div><strong style={{ color: 'var(--accent-cyan)' }}>CHARACTERS:</strong> {sc.characters.join(', ')}</div>
                            )}
                            <div style={{ marginTop: 4, padding: 8, background: 'rgba(139,92,246,0.08)', borderRadius: 4, color: 'var(--text-primary)', lineHeight: 1.5 }}>
                              <strong style={{ color: 'var(--accent-purple)' }}>NARRATION:</strong> {sc.narration || '(empty)'}
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
