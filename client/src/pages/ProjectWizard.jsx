import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { post, patch } from '../api/client.js';
import { useProject } from '../hooks/useProject.js';
import { useSSE } from '../hooks/useSSE.js';
import StepWizard from '../components/StepWizard.jsx';
import FileUploader from '../components/FileUploader.jsx';
import PanelGrid from '../components/PanelGrid.jsx';
import ScriptEditor from '../components/ScriptEditor.jsx';
import VoiceSelector from '../components/VoiceSelector.jsx';
import VideoPreview from '../components/VideoPreview.jsx';
import ProgressTracker from '../components/ProgressTracker.jsx';
import RenderSettings from '../components/RenderSettings.jsx';

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
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: '32px'
  },
  pageHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px'
  },
  backLink: {
    fontSize: '13px',
    color: 'var(--text-muted)',
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px'
  },
  projectName: {
    fontSize: '26px',
    fontWeight: 700,
    letterSpacing: '-0.5px'
  },
  stepContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px'
  },
  stepTitle: {
    fontSize: '18px',
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: '4px'
  },
  stepDesc: {
    fontSize: '14px',
    color: 'var(--text-muted)'
  },
  renderActions: {
    display: 'flex',
    gap: '12px',
    alignItems: 'center'
  },
  renderStatus: {
    fontSize: '13px',
    color: 'var(--text-secondary)'
  },
  errorBanner: {
    padding: '12px 16px',
    background: 'rgba(239,68,68,0.1)',
    border: '1px solid rgba(239,68,68,0.3)',
    borderRadius: '8px',
    color: 'var(--error)',
    fontSize: '13px'
  },
  loadingText: {
    color: 'var(--text-muted)',
    fontSize: '14px'
  }
};

// Determine the furthest incomplete step based on project.state
function resolveInitialStep(state) {
  if (!state) return 'upload';
  if (state.upload !== 'complete') return 'upload';
  if (state.script !== 'complete') return 'script';
  if (state.voice !== 'complete') return 'voice';
  return 'render';
}

export default function ProjectWizard() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { project, loading, error, load } = useProject(id);
  const progress = useSSE(id);

  const [step, setStep] = useState('upload');
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState(null);
  const [renderDuration, setRenderDuration] = useState(60);
  const [renderDetail, setRenderDetail] = useState('medium');
  const [renderFormat, setRenderFormat] = useState('manga');

  // Auto-run config
  const [autoRunEnabled, setAutoRunEnabled] = useState(true);
  const [autoVoiceEngine, setAutoVoiceEngine] = useState('edge');
  const [autoVoiceId, setAutoVoiceId] = useState('en-US-GuyNeural');
  const [autoElevenVoiceId, setAutoElevenVoiceId] = useState('pNInz6obpgDQGcFmaJgB');
  const autoTriggered = useRef({ script: false, voice: false, render: false, youtube: false });
  const [pipelineStarted, setPipelineStarted] = useState(false);
  const [pipelineKey, setPipelineKey] = useState(0); // incremented on each Start click to force effect re-run
  const [pipelineLogs, setPipelineLogs] = useState([]);
  const logsEndRef = useRef(null);

  // Publish config
  const [publishTarget, setPublishTarget] = useState('none'); // 'none' | 'youtube' | 'shorts'
  const [publishPrivacy, setPublishPrivacy] = useState('private');

  // Ref that always holds current settings values — avoids stale closures in auto-chain
  const settingsRef = useRef({});
  useEffect(() => {
    settingsRef.current = { autoVoiceEngine, autoVoiceId, autoElevenVoiceId, renderDuration, renderDetail, renderFormat, publishTarget, publishPrivacy };
  }, [autoVoiceEngine, autoVoiceId, autoElevenVoiceId, renderDuration, renderDetail, renderFormat, publishTarget, publishPrivacy]);
  const [youtubeAuthed, setYoutubeAuthed] = useState(null);
  const [youtubeAuthUrl, setYoutubeAuthUrl] = useState('');
  const [youtubeAuthCode, setYoutubeAuthCode] = useState('');
  const [youtubeUploadStatus, setYoutubeUploadStatus] = useState(null);

  // Once project loads for the first time, set the initial step and restore config
  useEffect(() => {
    if (project && !loading) {
      // With auto-run on, stay on the setup/upload step — the pipeline runs in the background.
      // With auto-run off, jump to the first incomplete step so the user can pick up where they left off.
      if (!autoRunEnabled) {
        setStep(resolveInitialStep(project.state));
      }
      // Restore saved render config if present
      if (project.config?.duration) setRenderDuration(project.config.duration);
      if (project.config?.detail) setRenderDetail(project.config.detail);
      if (project.config?.format) setRenderFormat(project.config.format);
    }
  }, [project?.id]); // only run when project id first resolves, not on every reload

  // Reload project when SSE reports a job finished
  useEffect(() => {
    if (progress && progress.percent === 100) {
      load();
    }
  }, [progress?.percent]);

  // Polling fallback: keep state fresh while pipeline is running (guards against SSE drops)
  useEffect(() => {
    if (!pipelineStarted) return;
    if (project?.state?.render === 'complete' || project?.state?.render === 'error') return;
    const timer = setInterval(() => load(), 3000);
    return () => clearInterval(timer);
  }, [pipelineStarted, project?.state?.render]);

  // Accumulate log entries from SSE during pipeline run
  useEffect(() => {
    if (!progress || progress.step === 'connected' || !pipelineStarted) return;
    if (!progress.message) return;
    const entry = {
      step: progress.step,
      message: progress.message,
      percent: progress.percent,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      isError: progress.percent === -1,
    };
    setPipelineLogs(prev => [...prev, entry]);
    // Update YouTube upload status from SSE
    if (progress.step === 'youtube') {
      if (progress.percent === 100 && progress.message.startsWith('Uploaded:')) {
        const url = progress.message.replace('Uploaded: ', '');
        setYoutubeUploadStatus(`done:${url}`);
      } else if (progress.percent === -1) {
        setYoutubeUploadStatus('error');
      }
    }
    // Auto-scroll to bottom
    setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  }, [progress?.message, progress?.step, progress?.percent]);

  // Persist duration/detail to project config whenever they change
  function handleDurationChange(value) {
    setRenderDuration(value);
    patch(`/projects/${id}/config`, { duration: value }).catch(() => {});
  }

  function handleDetailChange(value) {
    setRenderDetail(value);
    patch(`/projects/${id}/config`, { detail: value }).catch(() => {});
  }

  function handleFormatChange(value) {
    setRenderFormat(value);
    patch(`/projects/${id}/config`, { format: value }).catch(() => {});
  }

  async function handleRender() {
    setRendering(true);
    setRenderError(null);
    try {
      await post(`/projects/${id}/render`, {
        duration: renderDuration,
        detail: renderDetail,
        format: renderFormat,
      });
      // SSE will track progress; reload when done via the effect above
    } catch (e) {
      setRenderError(e.message);
      setRendering(false);
    }
  }

  // Reload clears the rendering spinner when state transitions to complete/error
  useEffect(() => {
    if (project?.state?.render === 'complete' || project?.state?.render === 'error') {
      setRendering(false);
    }
  }, [project?.state?.render]);

  function handleStartPipeline() {
    // Reset guards so re-runs from a previous session don't block this run
    autoTriggered.current = { script: false, voice: false, render: false, youtube: false };
    const panelsReady = project?.state?.panels === 'complete';
    const s = settingsRef.current;
    const voiceLabel = s.autoVoiceEngine === 'edge' ? s.autoVoiceId : s.autoElevenVoiceId;
    const publishLabel = s.publishTarget !== 'none' ? ` | Publish: ${s.publishTarget} (${s.publishPrivacy})` : '';
    const logs = [
      {
        step: 'pipeline',
        message: `Starting — Format: ${s.renderFormat} | Duration: ${s.renderDuration}s | Detail: ${s.renderDetail} | Voice: ${voiceLabel}${publishLabel}`,
        percent: 0,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        isError: false,
      },
    ];
    if (panelsReady) {
      logs.push({
        step: 'panels',
        message: 'Panel splitting already complete',
        percent: 100,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        isError: false,
      });
    }
    setPipelineLogs(logs);
    setPipelineStarted(true);
    setPipelineKey(k => k + 1); // force auto-chain effect to re-run even if state values are unchanged
  }

  // Check YouTube auth when publish target changes to youtube/shorts
  useEffect(() => {
    if (publishTarget === 'none') return;
    fetch('/api/youtube/status')
      .then(r => r.json())
      .then(d => setYoutubeAuthed(d.authenticated))
      .catch(() => setYoutubeAuthed(false));
  }, [publishTarget]);

  async function connectYoutube() {
    const r = await fetch('/api/youtube/auth-url');
    const d = await r.json();
    setYoutubeAuthUrl(d.url);
    window.open(d.url, '_blank');
  }

  async function submitYoutubeCode() {
    await fetch('/api/youtube/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: youtubeAuthCode }),
    });
    setYoutubeAuthed(true);
    setYoutubeAuthUrl('');
    setYoutubeAuthCode('');
  }

  // Auto-chain: watch state transitions and trigger next step automatically
  useEffect(() => {
    if (!autoRunEnabled || !project) return;
    const state = project.state || {};
    const uploadDone = state.upload === 'complete' || state.panels === 'complete';

    if (!pipelineStarted) return;

    // Wait until panel splitting is fully done — upload route holds the job lock while splitting
    const panelsReady = state.panels === 'complete';

    const s = settingsRef.current;

    function pushLog(step, message, percent = 0) {
      const entry = {
        step,
        message,
        percent,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        isError: false,
      };
      setPipelineLogs(prev => [...prev, entry]);
      setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }

    if (panelsReady && state.script !== 'complete' && state.script !== 'processing' && !autoTriggered.current.script) {
      autoTriggered.current.script = true;
      pushLog('script', `Generating narration script (target: ${s.renderDuration}s)…`);
      post(`/projects/${id}/script/generate`, { targetDuration: s.renderDuration }).catch(e => {
        autoTriggered.current.script = false;
        pushLog('script', `Failed to start: ${e.message}`);
        setRenderError(`Script failed to start: ${e.message}`);
      });
    } else if (state.script === 'complete' && state.voice !== 'complete' && state.voice !== 'processing' && !autoTriggered.current.voice) {
      autoTriggered.current.voice = true;
      const voiceId = s.autoVoiceEngine === 'edge' ? s.autoVoiceId : s.autoElevenVoiceId;
      pushLog('voice', `Generating voice narration (${s.autoVoiceEngine}: ${voiceId})…`);
      post(`/projects/${id}/voice/generate`, { voiceId, engine: s.autoVoiceEngine }).catch(e => {
        autoTriggered.current.voice = false;
        pushLog('voice', `Failed to start: ${e.message}`);
        setRenderError(`Voice failed to start: ${e.message}`);
      });
    } else if (state.voice === 'complete' && state.render !== 'complete' && state.render !== 'processing' && !autoTriggered.current.render) {
      autoTriggered.current.render = true;
      setRendering(true);
      setRenderError(null);
      pushLog('render', `Rendering video (${s.renderFormat}, ${s.renderDetail} quality)…`);
      post(`/projects/${id}/render`, {
        duration: s.renderDuration,
        detail: s.renderDetail,
        format: s.renderFormat,
      }).catch(e => {
        autoTriggered.current.render = false;
        pushLog('render', `Failed to start: ${e.message}`);
        setRenderError(e.message);
        setRendering(false);
      });
    } else if (state.render === 'complete' && s.publishTarget !== 'none' && youtubeAuthed && !autoTriggered.current.youtube) {
      autoTriggered.current.youtube = true;
      setYoutubeUploadStatus('uploading');
      pushLog('youtube', `Starting YouTube upload (${s.publishPrivacy})…`);
      const form = new FormData();
      form.append('privacy', s.publishPrivacy);
      if (s.publishTarget === 'shorts') form.append('isShorts', '1');
      // Server responds immediately with { started: true }, actual result comes via SSE
      fetch(`/api/youtube/upload/${id}`, { method: 'POST', body: form })
        .catch(() => {
          setYoutubeUploadStatus('error');
          pushLog('youtube', 'Upload request failed', -1);
        });
    }
  }, [
    project?.state?.upload,
    project?.state?.panels,
    project?.state?.script,
    project?.state?.voice,
    project?.state?.render,
    autoRunEnabled,
    publishTarget,
    youtubeAuthed,
    pipelineStarted,
    pipelineKey,
  ]);

  if (loading && !project) {
    return (
      <div style={styles.page}>
        <div style={styles.loadingText} className="pulse">Loading project...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.page}>
        <Link to="/" style={styles.backLink}>Back to Dashboard</Link>
        <div style={styles.errorBanner}>{error}</div>
      </div>
    );
  }

  const isUploadDone = project?.state?.upload === 'complete' || project?.state?.panels === 'complete';
  const isPanelsReady = project?.state?.panels === 'complete'; // panels fully split — safe to start pipeline
  const isJobRunning = progress && progress.step !== 'connected' && progress.percent !== 100 && progress.percent !== -1;

  return (
    <div style={styles.page} className="fade-in">
      <div style={styles.pageHeader}>
        <Link to="/" style={styles.backLink}>Back to Dashboard</Link>
        <h1 style={styles.projectName} className="gradient-text">
          {project?.name || 'Loading...'}
        </h1>
        {project?.seriesName && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Part of</span>
            <Link to="/series" style={{ fontSize: '13px', color: 'var(--accent-purple)', textDecoration: 'none', fontWeight: 500 }}>
              {project.seriesName}
            </Link>
            <span style={{ fontSize: '12px', background: 'rgba(139,92,246,0.15)', color: 'var(--accent-purple)', padding: '2px 8px', borderRadius: '10px' }}>
              Episode {project.episodeNumber}
            </span>
          </div>
        )}
      </div>

      {isJobRunning && (
        <ProgressTracker progress={progress} />
      )}

      {(() => {
        if (youtubeUploadStatus === 'uploading') {
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 16px', borderRadius: '8px', background: 'rgba(255,0,0,0.08)', border: '1px solid rgba(255,0,0,0.25)', fontSize: '13px', color: '#ff4444' }}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#ff4444', animation: 'pulse 1.2s ease-in-out infinite' }} />
              Uploading to YouTube...
            </div>
          );
        }
        if (youtubeUploadStatus?.startsWith('done:')) {
          const url = youtubeUploadStatus.slice(5);
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 16px', borderRadius: '8px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', fontSize: '13px', color: '#22c55e' }}>
              Uploaded to YouTube —{' '}
              <a href={url} target="_blank" rel="noreferrer" style={{ color: '#22c55e' }}>{url}</a>
            </div>
          );
        }
        if (youtubeUploadStatus === 'error') {
          return (
            <div style={{ padding: '10px 16px', borderRadius: '8px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', fontSize: '13px', color: 'var(--error)' }}>
              YouTube upload failed. You can retry manually from the render step.
            </div>
          );
        }
        if (!autoRunEnabled || !pipelineStarted) return null;
        const state = project?.state || {};
        let autoStatus = null;
        if (state.upload === 'complete' && (!state.panels || state.panels === 'processing')) autoStatus = 'Splitting panels...';
        else if (state.panels === 'complete' && (!state.script || state.script === 'processing')) autoStatus = 'Generating script...';
        else if (state.script === 'complete' && (!state.voice || state.voice === 'processing')) autoStatus = 'Generating voice narration...';
        else if (state.voice === 'complete' && (!state.render || state.render === 'processing')) autoStatus = 'Rendering video...';
        else if (state.render === 'complete' && publishTarget !== 'none' && youtubeAuthed && !youtubeUploadStatus) autoStatus = 'Preparing YouTube upload...';
        if (!autoStatus) return null;
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 16px', borderRadius: '8px', background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.3)', fontSize: '13px', color: 'var(--accent)' }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', animation: 'pulse 1.2s ease-in-out infinite' }} />
            Auto-run: {autoStatus}
          </div>
        );
      })()}

      <StepWizard
        currentStep={step}
        onStepChange={setStep}
        projectState={project?.state}
        autoRun={autoRunEnabled}
        uploadDone={isPanelsReady}
        pipelineStarted={pipelineStarted}
        onStart={handleStartPipeline}
      >
        {step === 'upload' && (
          <div style={styles.stepContent}>
            <div>
              <div style={styles.stepTitle}>Setup & Upload</div>
              <div style={styles.stepDesc}>
                Configure everything once — after upload the pipeline runs automatically.
              </div>
            </div>

            {/* ── Auto-run toggle ── */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              padding: '12px 16px',
              borderRadius: '10px',
              background: autoRunEnabled ? 'rgba(139,92,246,0.08)' : 'var(--bg-secondary)',
              border: `1px solid ${autoRunEnabled ? 'var(--accent)' : 'var(--glass-border)'}`,
            }}>
              <input
                type="checkbox"
                id="autoRun"
                checked={autoRunEnabled}
                onChange={e => setAutoRunEnabled(e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              <label htmlFor="autoRun" style={{ cursor: 'pointer', fontSize: '14px', fontWeight: 600, color: autoRunEnabled ? 'var(--accent)' : 'var(--text-primary)' }}>
                Auto-run after upload
              </label>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Script → Voice → Render will run without any clicks
              </span>
            </div>

            {/* ── Format ── */}
            <div>
              <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>Format Type</div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {[
                  { value: 'manga', label: 'Manga', desc: 'Grid panels, zooms per panel' },
                  { value: 'webtoon', label: 'Manhwa / Webtoon', desc: 'Tall strips, vertical scroll' },
                ].map(opt => (
                  <div
                    key={opt.value}
                    onClick={() => handleFormatChange(opt.value)}
                    style={{
                      padding: '12px 16px',
                      borderRadius: '10px',
                      border: renderFormat === opt.value ? '1px solid var(--accent)' : '1px solid var(--glass-border)',
                      background: renderFormat === opt.value ? 'rgba(139,92,246,0.1)' : 'var(--bg-secondary)',
                      cursor: 'pointer',
                      flex: '1 1 0',
                      minWidth: '140px',
                    }}
                  >
                    <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '4px', color: renderFormat === opt.value ? 'var(--accent)' : 'var(--text-primary)' }}>
                      {opt.label}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{opt.desc}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Duration ── */}
            <div>
              <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>Video Duration</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>Target length of the final video</div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {[
                  { label: '30s', value: 30 },
                  { label: '1 min', value: 60 },
                  { label: '5 min', value: 300 },
                  { label: '15 min', value: 900 },
                  { label: '30 min', value: 1800 },
                ].map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => handleDurationChange(opt.value)}
                    style={{
                      padding: '8px 16px',
                      borderRadius: '8px',
                      border: renderDuration === opt.value ? '1px solid var(--accent)' : '1px solid var(--glass-border)',
                      background: renderDuration === opt.value ? 'var(--accent-gradient)' : 'var(--bg-secondary)',
                      color: renderDuration === opt.value ? 'white' : 'var(--text-secondary)',
                      fontSize: '13px',
                      fontWeight: renderDuration === opt.value ? 600 : 500,
                      cursor: 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Detail Level ── */}
            <div>
              <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>Detail Level</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>Controls panel density and render quality</div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {[
                  { value: 'low', label: 'Low', desc: 'Fast render' },
                  { value: 'medium', label: 'Medium', desc: 'Balanced' },
                  { value: 'high', label: 'High', desc: 'Best quality' },
                ].map(opt => (
                  <div
                    key={opt.value}
                    onClick={() => handleDetailChange(opt.value)}
                    style={{
                      padding: '10px 16px',
                      borderRadius: '10px',
                      border: renderDetail === opt.value ? '1px solid var(--accent)' : '1px solid var(--glass-border)',
                      background: renderDetail === opt.value ? 'rgba(139,92,246,0.1)' : 'var(--bg-secondary)',
                      cursor: 'pointer',
                      flex: '1 1 0',
                      minWidth: '100px',
                    }}
                  >
                    <div style={{ fontSize: '13px', fontWeight: 600, color: renderDetail === opt.value ? 'var(--accent)' : 'var(--text-primary)' }}>{opt.label}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{opt.desc}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Voice ── */}
            <div>
              <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>Voice</div>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                {[
                  { value: 'edge', label: 'Free Voice' },
                  { value: 'elevenlabs', label: 'ElevenLabs (AI)' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setAutoVoiceEngine(opt.value)}
                    style={{
                      flex: 1,
                      padding: '10px 16px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      fontWeight: 500,
                      color: autoVoiceEngine === opt.value ? 'white' : 'var(--text-muted)',
                      background: autoVoiceEngine === opt.value ? 'var(--accent-purple)' : 'var(--glass-bg)',
                      border: `1px solid ${autoVoiceEngine === opt.value ? 'var(--accent-purple)' : 'var(--glass-border)'}`,
                      borderRadius: '8px',
                    }}
                  >
                    {opt.label}
                    {opt.value === 'edge' && (
                      <span style={{ fontSize: '11px', fontWeight: 600, color: '#22c55e', background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: '4px', padding: '1px 6px', marginLeft: '6px' }}>FREE</span>
                    )}
                  </button>
                ))}
              </div>
              {autoVoiceEngine === 'edge' ? (
                <select value={autoVoiceId} onChange={e => setAutoVoiceId(e.target.value)}>
                  {EDGE_VOICES.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                </select>
              ) : (
                <div>
                  <input
                    value={autoElevenVoiceId}
                    onChange={e => setAutoElevenVoiceId(e.target.value)}
                    placeholder="ElevenLabs Voice ID"
                  />
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    Find voice IDs at elevenlabs.io/voice-library
                  </div>
                </div>
              )}
            </div>

            {/* ── Publish ── */}
            <div>
              <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>Publish After Render</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>Auto-upload to YouTube once the video is ready</div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
                {[
                  { value: 'none', label: "Don't publish" },
                  { value: 'youtube', label: 'YouTube' },
                  { value: 'shorts', label: 'YouTube Shorts' },
                ].map(opt => (
                  <div
                    key={opt.value}
                    onClick={() => setPublishTarget(opt.value)}
                    style={{
                      padding: '10px 16px',
                      borderRadius: '10px',
                      border: publishTarget === opt.value ? '1px solid var(--accent)' : '1px solid var(--glass-border)',
                      background: publishTarget === opt.value ? 'rgba(139,92,246,0.1)' : 'var(--bg-secondary)',
                      cursor: 'pointer',
                      flex: '1 1 0',
                      minWidth: '110px',
                    }}
                  >
                    <div style={{ fontSize: '13px', fontWeight: 600, color: publishTarget === opt.value ? 'var(--accent)' : 'var(--text-primary)' }}>
                      {opt.label}
                    </div>
                  </div>
                ))}
              </div>

              {publishTarget !== 'none' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div>
                    <label>Privacy</label>
                    <select value={publishPrivacy} onChange={e => setPublishPrivacy(e.target.value)}>
                      <option value="private">Private</option>
                      <option value="unlisted">Unlisted</option>
                      <option value="public">Public</option>
                    </select>
                  </div>

                  {youtubeAuthed === false && !youtubeAuthUrl && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', borderRadius: '8px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)' }}>
                      <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>YouTube not connected</span>
                      <button className="btn-secondary" style={{ fontSize: '12px', padding: '5px 12px' }} onClick={connectYoutube}>
                        Connect YouTube
                      </button>
                    </div>
                  )}

                  {youtubeAuthed === false && youtubeAuthUrl && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px 14px', borderRadius: '8px', background: 'var(--bg-secondary)', border: '1px solid var(--glass-border)' }}>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>A browser tab opened. After approving, copy the code from the URL and paste here:</div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <input value={youtubeAuthCode} onChange={e => setYoutubeAuthCode(e.target.value)} placeholder="Paste auth code..." style={{ flex: 1 }} />
                        <button className="btn-primary" style={{ fontSize: '12px', padding: '6px 14px' }} onClick={submitYoutubeCode} disabled={!youtubeAuthCode}>Confirm</button>
                      </div>
                    </div>
                  )}

                  {youtubeAuthed === true && (
                    <div style={{ fontSize: '12px', color: '#22c55e', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span>YouTube connected</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Upload ── */}
            <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: '24px' }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '12px' }}>Upload Chapter Images</div>
              <FileUploader
                projectId={id}
                onUploadComplete={() => load()}
              />
            </div>

            {isUploadDone && (
              <PanelGrid projectId={id} />
            )}

            {pipelineStarted && pipelineLogs.length > 0 && (
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Pipeline Log</span>
                  <button
                    onClick={() => setPipelineLogs([])}
                    style={{ fontSize: '11px', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px' }}
                  >
                    Clear
                  </button>
                </div>
                <div style={{
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--glass-border)',
                  borderRadius: '8px',
                  padding: '12px',
                  maxHeight: '280px',
                  overflowY: 'auto',
                  fontFamily: 'monospace',
                  fontSize: '12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                }}>
                  {pipelineLogs.map((entry, i) => (
                    <div key={i} style={{ display: 'flex', gap: '10px', color: entry.isError ? 'var(--error)' : 'var(--text-secondary)', lineHeight: '1.5' }}>
                      <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{entry.time}</span>
                      <span style={{ color: entry.isError ? 'var(--error)' : 'var(--accent-cyan)', flexShrink: 0, minWidth: '70px' }}>[{entry.step}]</span>
                      <span style={{ color: entry.isError ? 'var(--error)' : 'var(--text-secondary)' }}>{entry.message}</span>
                      {!entry.isError && entry.percent > 0 && entry.percent < 100 && (
                        <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{entry.percent}%</span>
                      )}
                      {entry.percent === 100 && (
                        <span style={{ color: 'var(--success)', flexShrink: 0 }}>done</span>
                      )}
                    </div>
                  ))}
                  <div ref={logsEndRef} />
                </div>
              </div>
            )}
          </div>
        )}

        {step === 'script' && (
          <div style={styles.stepContent}>
            <div>
              <div style={styles.stepTitle}>Generate Narration Script</div>
              <div style={styles.stepDesc}>
                Set your target duration and detail level, then generate a script. The AI will write
                the right amount of narration to fill your target duration.
              </div>
            </div>
            <RenderSettings
              duration={renderDuration}
              detail={renderDetail}
              format={renderFormat}
              onDurationChange={handleDurationChange}
              onDetailChange={handleDetailChange}
              onFormatChange={handleFormatChange}
            />
            <ScriptEditor projectId={id} onScriptReady={load} targetDuration={renderDuration} progress={progress} />
          </div>
        )}

        {step === 'voice' && (
          <div style={styles.stepContent}>
            <div>
              <div style={styles.stepTitle}>Generate Voice Audio</div>
              <div style={styles.stepDesc}>
                Choose a voice from ElevenLabs or upload your own audio file.
              </div>
            </div>
            <VoiceSelector projectId={id} onVoiceReady={load} />
          </div>
        )}

        {step === 'render' && (
          <div style={styles.stepContent}>
            <div>
              <div style={styles.stepTitle}>Render Video</div>
              <div style={styles.stepDesc}>
                Combine your panels, narration, and background music into a final video.
              </div>
            </div>

            <RenderSettings
              duration={renderDuration}
              detail={renderDetail}
              format={renderFormat}
              onDurationChange={handleDurationChange}
              onDetailChange={handleDetailChange}
              onFormatChange={handleFormatChange}
            />

            <div style={styles.renderActions}>
              <button
                className="btn-primary"
                onClick={handleRender}
                disabled={rendering || project?.state?.voice !== 'complete'}
              >
                {rendering ? 'Rendering...' : project?.state?.render === 'complete' ? 'Re-render Video' : 'Render Video'}
              </button>
              {project?.state?.voice !== 'complete' && (
                <span style={styles.renderStatus}>
                  Complete the voice step first
                </span>
              )}
            </div>

            {renderError && <div style={styles.errorBanner}>{renderError}</div>}

            {isJobRunning && progress?.step?.toLowerCase().includes('render') && (
              <ProgressTracker progress={progress} />
            )}

            <VideoPreview projectId={id} project={project} />

            {project?.state?.render === 'complete' && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  className="btn-secondary"
                  onClick={() => navigate(`/projects/${id}/detail`)}
                >
                  View Full Detail
                </button>
              </div>
            )}
          </div>
        )}
      </StepWizard>
    </div>
  );
}
