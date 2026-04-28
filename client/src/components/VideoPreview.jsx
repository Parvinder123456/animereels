import React, { useEffect, useRef, useState } from 'react';
import { get, post } from '../api/client.js';

const styles = {
  container: { display: 'flex', flexDirection: 'column', gap: '16px', alignItems: 'center' },
  video: { width: '100%', maxWidth: '540px', borderRadius: '12px', border: '1px solid var(--glass-border)', background: '#000' },
  info: { display: 'flex', gap: '12px', alignItems: 'center', fontSize: '14px', color: 'var(--text-secondary)', flexWrap: 'wrap', justifyContent: 'center' },
  noVideo: { textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)', fontSize: '14px' },
  modal: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modalBox: { background: 'var(--bg-secondary, #0f1729)', border: '1px solid var(--glass-border)', borderRadius: '14px', padding: '28px', width: '420px', display: 'flex', flexDirection: 'column', gap: '14px' },
};

function YouTubeUploadModal({ projectId, onClose }) {
  const [authed, setAuthed] = useState(null);
  const [authUrl, setAuthUrl] = useState('');
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [privacy, setPrivacy] = useState('private');
  const [isShorts, setIsShorts] = useState(false);
  const [thumb, setThumb] = useState(null);
  const [status, setStatus] = useState('');
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const fileRef = useRef();

  useEffect(() => {
    get('/youtube/status').then(d => setAuthed(d.authenticated));
  }, []);

  async function loadAuthUrl() {
    const d = await get('/youtube/auth-url');
    setAuthUrl(d.url);
    window.open(d.url, '_blank');
  }

  async function submitCode() {
    await post('/youtube/callback', { code });
    setAuthed(true);
  }

  async function upload() {
    setUploading(true);
    setStatus('Preparing upload...');
    try {
      const form = new FormData();
      const finalTitle = isShorts ? `${title} #Shorts`.trim() : title;
      const finalDesc  = isShorts ? `${description}\n\n#Shorts`.trim() : description;
      if (finalTitle) form.append('title', finalTitle);
      if (finalDesc)  form.append('description', finalDesc);
      form.append('privacy', privacy);
      form.append('isShorts', isShorts ? '1' : '0');
      if (thumb) form.append('thumbnail', thumb);

      const res = await fetch(`/api/youtube/upload/${projectId}`, { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setResult(data);
      setStatus('');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
    setUploading(false);
  }

  const input = (label, val, set, props = {}) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <label style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>{label}</label>
      <input value={val} onChange={e => set(e.target.value)} style={{ background: 'var(--bg-primary, #0a0e1a)', border: '1px solid var(--glass-border)', borderRadius: '8px', padding: '8px 10px', color: 'var(--text-primary)', fontSize: '13px' }} {...props} />
    </div>
  );

  return (
    <div style={styles.modal} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={styles.modalBox}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600, fontSize: '15px' }}>Upload to YouTube</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '18px' }}>×</button>
        </div>

        {authed === null && <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Checking auth...</div>}

        {authed === false && !authUrl && (
          <button onClick={loadAuthUrl} className="btn-primary">Connect YouTube Account</button>
        )}

        {authed === false && authUrl && (
          <>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>A browser tab opened for Google login. After approving, copy the code from the URL bar (after <code>?code=</code>) and paste below.</div>
            {input('Auth Code', code, setCode, { placeholder: 'Paste code here...' })}
            <button onClick={submitCode} className="btn-primary" disabled={!code}>Confirm</button>
          </>
        )}

        {authed === true && !result && (
          <>
            {input('Title (optional — uses script title)', title, setTitle, { placeholder: 'Auto from script' })}
            {input('Description (optional)', description, setDescription, { placeholder: 'Auto from script' })}
            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '8px 0' }}>
              <input type="checkbox" checked={isShorts} onChange={e => setIsShorts(e.target.checked)} style={{ width: 16, height: 16, cursor: 'pointer' }} />
              <span style={{ fontSize: '13px', fontWeight: 500 }}>Upload as YouTube Shorts</span>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>(adds #Shorts)</span>
            </label>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>Privacy</label>
              <select value={privacy} onChange={e => setPrivacy(e.target.value)} style={{ background: 'var(--bg-primary, #0a0e1a)', border: '1px solid var(--glass-border)', borderRadius: '8px', padding: '8px 10px', color: 'var(--text-primary)', fontSize: '13px' }}>
                <option value="private">Private</option>
                <option value="unlisted">Unlisted</option>
                <option value="public">Public</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>Thumbnail (optional)</label>
              <input ref={fileRef} type="file" accept="image/*" onChange={e => setThumb(e.target.files[0])} style={{ fontSize: '12px', color: 'var(--text-secondary)' }} />
            </div>
            {status && <div style={{ fontSize: '12px', color: '#f59e0b' }}>{status}</div>}
            <button onClick={upload} className="btn-primary" disabled={uploading}>{uploading ? 'Uploading...' : 'Upload'}</button>
          </>
        )}

        {result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center' }}>
            <div style={{ color: '#34d399', fontWeight: 600 }}>Uploaded successfully!</div>
            <a href={result.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-purple)', fontSize: '13px' }}>{result.url}</a>
          </div>
        )}
      </div>
    </div>
  );
}

export default function VideoPreview({ projectId, project }) {
  const [showUpload, setShowUpload] = useState(false);

  if (!project || project.state?.render !== 'complete') {
    return <div style={styles.noVideo}>No video rendered yet. Complete all steps to generate your video.</div>;
  }

  const videoUrl = `/data/${projectId}/output/final.mp4?t=${Date.now()}`;
  const downloadUrl = `/api/projects/${projectId}/download`;

  return (
    <div style={styles.container}>
      <video controls src={videoUrl} style={styles.video} preload="metadata" />
      <div style={styles.info}>
        {project.stats?.videoDurationSec > 0 && <span>Duration: {project.stats.videoDurationSec}s</span>}
        <a href={downloadUrl} className="btn-primary" style={{ textDecoration: 'none' }}>Download MP4</a>
        <button onClick={() => setShowUpload(true)} style={{ background: 'rgba(255,0,0,0.12)', border: '1px solid rgba(255,0,0,0.3)', color: '#ff4444', borderRadius: '8px', padding: '8px 16px', cursor: 'pointer', fontSize: '13px', fontWeight: 500 }}>
          Upload to YouTube
        </button>
      </div>
      {showUpload && <YouTubeUploadModal projectId={projectId} onClose={() => setShowUpload(false)} />}
    </div>
  );
}
