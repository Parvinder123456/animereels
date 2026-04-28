import React, { useState, useEffect } from 'react';
import { get, post, put } from '../api/client.js';

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px'
  },
  actions: {
    display: 'flex',
    gap: '12px',
    flexWrap: 'wrap'
  },
  textarea: {
    minHeight: '300px',
    resize: 'vertical',
    fontFamily: 'monospace',
    fontSize: '13px',
    lineHeight: '1.7'
  },
  meta: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px'
  },
  stats: {
    fontSize: '13px',
    color: 'var(--text-muted)',
    display: 'flex',
    gap: '16px'
  },
  error: {
    color: 'var(--error)',
    fontSize: '13px'
  },
  success: {
    color: 'var(--success)',
    fontSize: '13px'
  }
};

export default function ScriptEditor({ projectId, onScriptReady, targetDuration, progress }) {
  const [script, setScript] = useState({ title: '', hook: '', segments: [] });
  const [text, setText] = useState('');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const pollRef = React.useRef(null);

  useEffect(() => {
    if (!projectId) return;
    get(`/projects/${projectId}/script`)
      .then(data => {
        setScript(data);
        setText(data.segments?.map(s => s.text).join('\n\n') || '');
      })
      .catch(() => {});
  }, [projectId]);

  // Stop polling if SSE reports error or completion
  useEffect(() => {
    if (!progress || !generating) return;
    if (progress.step === 'script' && progress.percent === -1) {
      clearInterval(pollRef.current);
      setGenerating(false);
      setError(progress.message?.replace(/^Error:\s*/i, '') || 'Script generation failed');
    }
    if (progress.step === 'script' && progress.percent === 100) {
      clearInterval(pollRef.current);
      get(`/projects/${projectId}/script`).then(data => {
        if (data.segments?.length > 0) {
          setScript(data);
          setText(data.segments.map(s => s.text).join('\n\n'));
          onScriptReady?.();
        }
        setGenerating(false);
      }).catch(() => setGenerating(false));
    }
  }, [progress?.percent, progress?.step]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      await post(`/projects/${projectId}/script/generate`, {
        targetDuration: targetDuration || undefined,
      });
      // Poll as fallback if SSE is unavailable
      pollRef.current = setInterval(async () => {
        try {
          const data = await get(`/projects/${projectId}/script`);
          if (data.segments?.length > 0) {
            setScript(data);
            setText(data.segments.map(s => s.text).join('\n\n'));
            setGenerating(false);
            onScriptReady?.();
            clearInterval(pollRef.current);
          }
        } catch {}
      }, 4000);
      // Timeout after 5 minutes
      setTimeout(() => { clearInterval(pollRef.current); setGenerating(false); }, 300000);
    } catch (err) {
      setError(err.message);
      setGenerating(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      // Parse text back into segments (split on double newlines)
      const segments = text.split(/\n\n+/).filter(Boolean).map(t => ({
        text: t.trim(),
        mood: 'dramatic',
        panelHint: ''
      }));
      const data = await put(`/projects/${projectId}/script`, {
        title: script.title,
        hook: script.hook,
        segments
      });
      setScript(data);
      setSaved(true);
      onScriptReady?.();
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;

  return (
    <div style={styles.container}>
      <div style={styles.meta}>
        <div>
          <label>Title</label>
          <input
            value={script.title}
            onChange={e => setScript({ ...script, title: e.target.value })}
            placeholder="Video title"
          />
        </div>
        <div>
          <label>Hook</label>
          <input
            value={script.hook}
            onChange={e => setScript({ ...script, hook: e.target.value })}
            placeholder="Opening hook line"
          />
        </div>
      </div>

      <div>
        <label>Narration Script</label>
        <textarea
          style={styles.textarea}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Write your narration script here, or generate one with AI...&#10;&#10;Separate segments with blank lines."
        />
      </div>

      <div style={styles.stats}>
        <span>{wordCount} words</span>
        <span>{script.segments?.length || 0} segments</span>
        <span>~{Math.ceil(wordCount / 2.5)}s estimated audio</span>
        {targetDuration && (
          <span>Target: {targetDuration >= 60 ? `${(targetDuration / 60).toFixed(1)} min` : `${targetDuration}s`} ({Math.round(targetDuration / 60 * 150)} words)</span>
        )}
      </div>

      <div style={styles.actions}>
        <button className="btn-primary" onClick={handleGenerate} disabled={generating}>
          {generating ? 'Generating...' : 'Generate with AI'}
        </button>
        <button className="btn-secondary" onClick={handleSave} disabled={saving || !text.trim()}>
          {saving ? 'Saving...' : 'Save Script'}
        </button>
      </div>

      {generating && progress?.step === 'script' && progress.percent > 0 && (
        <div style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--accent-cyan)', animation: 'pulse 1.2s ease-in-out infinite' }} />
          {progress.message} ({progress.percent}%)
        </div>
      )}
      {error && <div style={styles.error}>{error}</div>}
      {saved && <div style={styles.success}>Script saved successfully</div>}
    </div>
  );
}
