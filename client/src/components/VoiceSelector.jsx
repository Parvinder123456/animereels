import React, { useState } from 'react';
import { post } from '../api/client.js';

const EDGE_VOICES = [
  { id: 'en-US-GuyNeural',         label: 'Guy — Deep Male Narrator' },
  { id: 'en-US-ChristopherNeural', label: 'Christopher — Authoritative Male' },
  { id: 'en-US-EricNeural',        label: 'Eric — Friendly Male' },
  { id: 'en-US-RogerNeural',       label: 'Roger — Warm Male' },
  { id: 'en-US-AriaNeural',        label: 'Aria — Versatile Female' },
  { id: 'en-US-JennyNeural',       label: 'Jenny — Conversational Female' },
  { id: 'en-US-SaraNeural',        label: 'Sara — Smooth Female' },
  { id: 'en-US-TonyNeural',        label: 'Tony — Casual Male' },
];

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px'
  },
  engineRow: {
    display: 'flex',
    gap: '8px'
  },
  engineBtn: {
    flex: 1,
    padding: '10px 16px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
    color: 'var(--text-muted)',
    background: 'var(--glass-bg)',
    border: '1px solid var(--glass-border)',
    borderRadius: '8px',
    transition: 'all 0.2s'
  },
  engineBtnActive: {
    color: 'var(--text-primary)',
    background: 'var(--accent-purple)',
    borderColor: 'var(--accent-purple)'
  },
  tabs: {
    display: 'flex',
    gap: '0',
    borderBottom: '1px solid var(--glass-border)'
  },
  tab: {
    padding: '10px 20px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 500,
    color: 'var(--text-muted)',
    border: 'none',
    background: 'none',
    borderBottom: '2px solid transparent',
    transition: 'color 0.2s, border-color 0.2s'
  },
  activeTab: {
    color: 'var(--text-primary)',
    borderBottomColor: 'var(--accent-purple)'
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px'
  },
  row: {
    display: 'flex',
    gap: '12px',
    alignItems: 'flex-end'
  },
  audioPlayer: {
    width: '100%',
    marginTop: '12px',
    borderRadius: '8px'
  },
  hint: {
    fontSize: '12px',
    color: 'var(--text-muted)',
    marginTop: '4px'
  },
  freeBadge: {
    display: 'inline-block',
    fontSize: '11px',
    fontWeight: 600,
    color: '#22c55e',
    background: 'rgba(34,197,94,0.12)',
    border: '1px solid rgba(34,197,94,0.3)',
    borderRadius: '4px',
    padding: '1px 6px',
    marginLeft: '6px',
    verticalAlign: 'middle'
  }
};

export default function VoiceSelector({ projectId, onVoiceReady }) {
  const [engine, setEngine] = useState('edge');
  const [tab, setTab] = useState('voice');
  const [voiceId, setVoiceId] = useState('pNInz6obpgDQGcFmaJgB');
  const [edgeVoiceId, setEdgeVoiceId] = useState('en-US-GuyNeural');
  const [generating, setGenerating] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);

  const activeVoiceId = engine === 'edge' ? edgeVoiceId : voiceId;

  async function handlePreview() {
    setError(null);
    try {
      const result = await post(`/projects/${projectId}/voice/preview`, {
        voiceId: activeVoiceId,
        engine
      });
      setPreviewUrl(result.audioUrl + '?t=' + Date.now());
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      await post(`/projects/${projectId}/voice/generate`, {
        voiceId: activeVoiceId,
        engine
      });
      const poll = setInterval(async () => {
        try {
          const proj = await (await fetch(`/api/projects/${projectId}`)).json();
          if (proj.state?.voice === 'complete') {
            setAudioUrl(`/data/${projectId}/audio/narration.mp3?t=${Date.now()}`);
            setGenerating(false);
            onVoiceReady?.();
            clearInterval(poll);
          } else if (proj.state?.voice === 'error') {
            setError('Voice generation failed');
            setGenerating(false);
            clearInterval(poll);
          }
        } catch {}
      }, 3000);
      setTimeout(() => { clearInterval(poll); setGenerating(false); }, 600000);
    } catch (err) {
      setError(err.message);
      setGenerating(false);
    }
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('audio', file);
      await post(`/projects/${projectId}/voice/upload`, formData);
      setAudioUrl(`/data/${projectId}/audio/${file.name}?t=${Date.now()}`);
      onVoiceReady?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div style={styles.container}>
      {/* Mode tabs */}
      <div style={styles.tabs}>
        <button
          style={{ ...styles.tab, ...(tab === 'voice' ? styles.activeTab : {}) }}
          onClick={() => setTab('voice')}
        >
          Generate Voice
        </button>
        <button
          style={{ ...styles.tab, ...(tab === 'upload' ? styles.activeTab : {}) }}
          onClick={() => setTab('upload')}
        >
          Upload Recording
        </button>
      </div>

      {tab === 'voice' && (
        <div style={styles.section}>
          {/* Engine picker */}
          <div style={styles.engineRow}>
            <button
              style={{ ...styles.engineBtn, ...(engine === 'edge' ? styles.engineBtnActive : {}) }}
              onClick={() => setEngine('edge')}
            >
              Free Voice
              <span style={styles.freeBadge}>FREE</span>
            </button>
            <button
              style={{ ...styles.engineBtn, ...(engine === 'elevenlabs' ? styles.engineBtnActive : {}) }}
              onClick={() => setEngine('elevenlabs')}
            >
              ElevenLabs (AI)
            </button>
          </div>

          {/* Edge TTS options */}
          {engine === 'edge' && (
            <div>
              <label>Voice</label>
              <select value={edgeVoiceId} onChange={e => setEdgeVoiceId(e.target.value)}>
                {EDGE_VOICES.map(v => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </select>
              <div style={styles.hint}>
                Microsoft neural TTS — no API key required, internet connection needed
              </div>
            </div>
          )}

          {/* ElevenLabs options */}
          {engine === 'elevenlabs' && (
            <div>
              <label>ElevenLabs Voice ID</label>
              <input
                value={voiceId}
                onChange={e => setVoiceId(e.target.value)}
                placeholder="Enter voice ID"
              />
              <div style={styles.hint}>
                Find voice IDs at elevenlabs.io/voice-library
              </div>
            </div>
          )}

          <div style={styles.row}>
            <button className="btn-secondary" onClick={handlePreview} disabled={generating}>
              Preview (15s)
            </button>
            <button className="btn-primary" onClick={handleGenerate} disabled={generating}>
              {generating ? 'Generating...' : 'Generate Full Narration'}
            </button>
          </div>

          {previewUrl && (
            <audio controls src={previewUrl} style={styles.audioPlayer} />
          )}
        </div>
      )}

      {tab === 'upload' && (
        <div style={styles.section}>
          <div>
            <label>Upload Audio File</label>
            <input
              type="file"
              accept=".mp3,.wav,.m4a,.ogg"
              onChange={handleUpload}
              disabled={uploading}
            />
            <div style={styles.hint}>
              Supports MP3, WAV, M4A, OGG
            </div>
          </div>
        </div>
      )}

      {audioUrl && (
        <div>
          <label>Generated Narration</label>
          <audio controls src={audioUrl} style={styles.audioPlayer} />
        </div>
      )}

      {error && (
        <div style={{ color: 'var(--error)', fontSize: '13px' }}>{error}</div>
      )}
    </div>
  );
}
