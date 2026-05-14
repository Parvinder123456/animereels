import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post, patch, del } from '../api/client.js';

const PROJECT_TYPES = [
  { value: 'manga',           label: 'Manga / Manhwa',     subtitle: 'Upload chapter images.',                               icon: '\u{1F4D6}' },
  { value: 'video_summary',   label: 'Video Summary',      subtitle: 'Upload an anime episode → narrated recap.',            icon: '\u{1F3AC}' },
  { value: 'video_explainer', label: 'Video Explainer',    subtitle: 'YouTube URL or upload → AI narrated recap video.',     icon: '\u{1F4FA}' },
  { value: 'shorts',          label: 'YouTube Shorts',     subtitle: 'AI picks the best moments → vertical clips.',          icon: '\u{2702}\u{FE0F}' },
  { value: 'translate',       label: 'YouTube Hindi → EN', subtitle: 'Paste a Hindi YouTube URL → English clip.',            icon: '\u{1F310}' },
];

const styles = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: '32px'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  title: {
    fontSize: '28px',
    fontWeight: 700,
    letterSpacing: '-0.5px'
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: '20px'
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '16px'
  },
  cardName: {
    fontSize: '16px',
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: '4px'
  },
  cardDate: {
    fontSize: '12px',
    color: 'var(--text-muted)'
  },
  badges: {
    display: 'flex',
    gap: '6px',
    flexWrap: 'wrap',
    marginBottom: '16px'
  },
  badge: {
    fontSize: '11px',
    fontWeight: 600,
    padding: '3px 8px',
    borderRadius: '4px',
    textTransform: 'uppercase',
    letterSpacing: '0.4px'
  },
  stats: {
    display: 'flex',
    gap: '16px',
    fontSize: '12px',
    color: 'var(--text-muted)',
    marginBottom: '16px',
    flexWrap: 'wrap'
  },
  statItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px'
  },
  statLabel: {
    fontSize: '10px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    color: 'var(--text-muted)'
  },
  statValue: {
    fontSize: '14px',
    fontWeight: 600,
    color: 'var(--text-secondary)'
  },
  cardFooter: {
    display: 'flex',
    justifyContent: 'flex-end'
  },
  emptyState: {
    textAlign: 'center',
    padding: '80px 20px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '16px'
  },
  emptyIcon: {
    fontSize: '64px',
    opacity: 0.3
  },
  emptyTitle: {
    fontSize: '20px',
    fontWeight: 600,
    color: 'var(--text-secondary)'
  },
  emptySubtitle: {
    fontSize: '14px',
    color: 'var(--text-muted)',
    maxWidth: '300px'
  },
  // Modal overlay
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 200
  },
  modal: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--glass-border)',
    borderRadius: '16px',
    padding: '32px',
    width: '100%',
    maxWidth: '420px',
    display: 'flex',
    flexDirection: 'column',
    gap: '20px'
  },
  modalTitle: {
    fontSize: '20px',
    fontWeight: 700
  },
  modalActions: {
    display: 'flex',
    gap: '12px',
    justifyContent: 'flex-end'
  },
  errorBanner: {
    padding: '12px 16px',
    background: 'rgba(239,68,68,0.1)',
    border: '1px solid rgba(239,68,68,0.3)',
    borderRadius: '8px',
    color: 'var(--error)',
    fontSize: '13px'
  }
};

const STATE_STEPS = ['upload', 'panels', 'script', 'voice', 'render'];

function badgeStyle(state) {
  switch (state) {
    case 'complete': return { ...styles.badge, background: 'rgba(16,185,129,0.15)', color: 'var(--success)' };
    case 'processing': return { ...styles.badge, background: 'rgba(6,182,212,0.15)', color: 'var(--accent-cyan)' };
    case 'error': return { ...styles.badge, background: 'rgba(239,68,68,0.15)', color: 'var(--error)' };
    default: return { ...styles.badge, background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' };
  }
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });
}

function ProjectCard({ project, onDelete, onClick }) {
  const { name, createdAt, state = {}, stats = {} } = project;

  return (
    <div className="glass-card-hover fade-in" onClick={onClick}>
      <div style={styles.cardHeader}>
        <div>
          <div style={styles.cardName}>{name}</div>
          <div style={styles.cardDate}>{formatDate(createdAt)}</div>
        </div>
      </div>

      <div style={styles.badges}>
        {STATE_STEPS.map(step => (
          <span key={step} style={badgeStyle(state[step])}>
            {step}
          </span>
        ))}
      </div>

      <div style={styles.stats}>
        {stats.panelCount > 0 && (
          <div style={styles.statItem}>
            <span style={styles.statLabel}>Panels</span>
            <span style={styles.statValue}>{stats.panelCount}</span>
          </div>
        )}
        {stats.scriptWordCount > 0 && (
          <div style={styles.statItem}>
            <span style={styles.statLabel}>Words</span>
            <span style={styles.statValue}>{stats.scriptWordCount}</span>
          </div>
        )}
        {stats.audioDurationSec > 0 && (
          <div style={styles.statItem}>
            <span style={styles.statLabel}>Audio</span>
            <span style={styles.statValue}>{stats.audioDurationSec}s</span>
          </div>
        )}
        {stats.videoDurationSec > 0 && (
          <div style={styles.statItem}>
            <span style={styles.statLabel}>Video</span>
            <span style={styles.statValue}>{stats.videoDurationSec}s</span>
          </div>
        )}
      </div>

      <div style={styles.cardFooter}>
        <button
          className="btn-danger"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('manga');
  const [newUrl, setNewUrl] = useState('');
  const [newTopic, setNewTopic] = useState('');
  const [newManual, setNewManual] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  useEffect(() => {
    loadProjects();
  }, []);

  async function loadProjects() {
    setLoading(true);
    setError(null);
    try {
      const data = await get('/projects');
      setProjects(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    setCreating(true);
    setCreateError(null);
    try {
      if (newType === 'shorts') {
        if (!newUrl.trim()) throw new Error('YouTube URL is required');
        const { id } = await post('/shorts', {
          name: newName.trim() || undefined,
          url: newUrl.trim(),
        });
        setShowModal(false);
        resetModal();
        navigate(`/projects/${id}/shorts`);
        return;
      }

      if (newType === 'translate') {
        if (!newUrl.trim()) throw new Error('YouTube URL is required');
        const { id } = await post('/translate', {
          name: newName.trim() || undefined,
          url: newUrl.trim(),
          topic: newTopic.trim() || undefined,
          mode: newManual ? 'manual' : 'auto',
        });
        setShowModal(false);
        resetModal();
        navigate(`/projects/${id}/translate`);
        return;
      }

      if (!newName.trim()) throw new Error('Project name is required');
      const project = await post('/projects', { name: newName.trim() });

      if (newType === 'video_summary') {
        await patch(`/projects/${project.id}/config`, { projectType: 'video_summary' });
        setShowModal(false);
        resetModal();
        navigate(`/projects/${project.id}/video`);
        return;
      }

      if (newType === 'video_explainer') {
        await patch(`/projects/${project.id}/config`, { projectType: 'video_explainer' });
        setShowModal(false);
        resetModal();
        navigate(`/projects/${project.id}/explainer`);
        return;
      }

      setShowModal(false);
      resetModal();
      navigate(`/projects/${project.id}`);
    } catch (e) {
      setCreateError(e.message);
    } finally {
      setCreating(false);
    }
  }

  function resetModal() {
    setNewName('');
    setNewUrl('');
    setNewTopic('');
    setNewType('manga');
    setNewManual(false);
  }

  async function handleDelete(project) {
    if (!window.confirm(`Delete "${project.name}"? This cannot be undone.`)) return;
    try {
      await del(`/projects/${project.id}`);
      setProjects(prev => prev.filter(p => p.id !== project.id));
    } catch (e) {
      setError(e.message);
    }
  }

  function handleCardClick(project) {
    const type = project.config?.projectType;
    if (type === 'translate') {
      navigate(`/projects/${project.id}/translate`);
    } else if (type === 'shorts') {
      navigate(`/projects/${project.id}/shorts`);
    } else {
      navigate(`/projects/${project.id}/explainer`);
    }
  }

  function openModal() {
    resetModal();
    setCreateError(null);
    setShowModal(true);
  }

  function handleModalKeyDown(e) {
    if (e.key === 'Enter') handleCreate();
    if (e.key === 'Escape') setShowModal(false);
  }

  return (
    <div style={styles.page} className="fade-in">
      <div style={styles.header}>
        <h1 style={styles.title} className="gradient-text">My Projects</h1>
        <button className="btn-primary" onClick={openModal}>
          + New Project
        </button>
      </div>

      {error && <div style={styles.errorBanner}>{error}</div>}

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '14px' }} className="pulse">
          Loading projects...
        </div>
      ) : projects.length === 0 ? (
        <div style={styles.emptyState}>
          <span style={styles.emptyIcon}>*</span>
          <div style={styles.emptyTitle}>No projects yet</div>
          <div style={styles.emptySubtitle}>
            Create your first project to generate AI-narrated recap videos from YouTube or uploaded content.
          </div>
          <button className="btn-primary" onClick={openModal}>
            Create Your First Project
          </button>
        </div>
      ) : (
        <div style={styles.grid}>
          {projects.map(project => (
            <ProjectCard
              key={project.id}
              project={project}
              onClick={() => handleCardClick(project)}
              onDelete={() => handleDelete(project)}
            />
          ))}
        </div>
      )}

      {showModal && (
        <div style={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) setShowModal(false); }}>
          <div style={styles.modal} className="fade-in">
            <div style={styles.modalTitle}>New Project</div>

            <div>
              <label style={{ display: 'block', marginBottom: 8, fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Project Type
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {PROJECT_TYPES.map(t => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setNewType(t.value)}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 12px',
                      borderRadius: 8, textAlign: 'left',
                      border: `1px solid ${newType === t.value ? 'var(--accent-purple)' : 'var(--glass-border)'}`,
                      background: newType === t.value ? 'rgba(139,92,246,0.10)' : 'transparent',
                      color: 'var(--text-primary)', cursor: 'pointer',
                    }}
                  >
                    <span style={{ fontSize: 20 }}>{t.icon}</span>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{t.label}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.subtitle}</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {newType === 'video_explainer' && (
              <div>
                <label>Project Name (optional — auto-filled from video title)</label>
                <input
                  type="text"
                  placeholder="e.g. Huberman Lab Sleep Episode Recap"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={handleModalKeyDown}
                  autoFocus
                />
              </div>
            )}

            {newType === 'shorts' && (
              <>
                <div>
                  <label>YouTube URL</label>
                  <input
                    type="url"
                    placeholder="https://www.youtube.com/watch?v=..."
                    value={newUrl}
                    onChange={e => setNewUrl(e.target.value)}
                    autoFocus
                  />
                </div>
                <div>
                  <label>Project Name (optional)</label>
                  <input
                    type="text"
                    placeholder="defaults to the video title"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                  />
                </div>
              </>
            )}

            {newType === 'translate' && (
              <>
                <div>
                  <label>YouTube URL</label>
                  <input
                    type="url"
                    placeholder="https://www.youtube.com/watch?v=..."
                    value={newUrl}
                    onChange={e => setNewUrl(e.target.value)}
                    autoFocus
                  />
                </div>
                <div>
                  <label>Topic (optional)</label>
                  <input
                    type="text"
                    placeholder="e.g. AI in education — leave blank for first 3 min"
                    value={newTopic}
                    onChange={e => setNewTopic(e.target.value)}
                  />
                </div>
                <div>
                  <label>Project Name (optional)</label>
                  <input
                    type="text"
                    placeholder="defaults to the video title"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                  />
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={newManual} onChange={e => setNewManual(e.target.checked)} />
                  I'll paste the transcript myself (free — use Gemini mobile or any other source)
                </label>
              </>
            )}

            {createError && <div style={styles.errorBanner}>{createError}</div>}

            <div style={styles.modalActions}>
              <button className="btn-secondary" onClick={() => setShowModal(false)} disabled={creating}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={handleCreate}
                disabled={creating || ((newType === 'translate' || newType === 'shorts') && !newUrl.trim())}
              >
                {creating ? 'Creating...' : 'Create Project'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
