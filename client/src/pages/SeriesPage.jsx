import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post, del } from '../api/client.js';

const s = {
  page: { display: 'flex', flexDirection: 'column', gap: '32px' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: '28px', fontWeight: 700, letterSpacing: '-0.5px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '20px' },
  card: { display: 'flex', flexDirection: 'column', gap: '12px' },
  cardName: { fontSize: '17px', fontWeight: 600 },
  episodeList: { display: 'flex', flexDirection: 'column', gap: '6px' },
  epRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', background: 'rgba(255,255,255,0.04)', borderRadius: '6px', fontSize: '13px' },
  summary: { fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5, padding: '8px 10px', background: 'rgba(139,92,246,0.06)', borderRadius: '6px', borderLeft: '2px solid var(--accent-purple)' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 },
  modal: { background: 'var(--bg-secondary)', border: '1px solid var(--glass-border)', borderRadius: '16px', padding: '28px', width: '100%', maxWidth: '440px', display: 'flex', flexDirection: 'column', gap: '18px' },
  modalTitle: { fontSize: '18px', fontWeight: 700 },
  modalActions: { display: 'flex', gap: '10px', justifyContent: 'flex-end' },
  err: { padding: '10px 14px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', color: 'var(--error)', fontSize: '13px' },
};

function SeriesCard({ series, projects, onDelete, onAddEpisode, onRemoveEpisode, onClick }) {
  const episodes = series.episodes || [];

  return (
    <div className="glass-card fade-in" style={s.card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ ...s.cardName, cursor: 'pointer' }} onClick={onClick} className="gradient-text" role="button">
          {series.name}
        </div>
        <button className="btn-danger" style={{ fontSize: '11px', padding: '3px 8px' }} onClick={onDelete}>Delete</button>
      </div>

      <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px' }}>
        {episodes.length} episode{episodes.length !== 1 ? 's' : ''}
      </div>

      {episodes.length > 0 && (
        <div style={s.episodeList}>
          {episodes.map(ep => {
            const proj = projects.find(p => p.id === ep.projectId);
            return (
              <div key={ep.projectId} style={s.epRow}>
                <span style={{ color: 'var(--text-muted)', minWidth: 60 }}>Ep {ep.episode}</span>
                <span style={{ flex: 1 }}>{proj?.name || ep.projectId}</span>
                <button
                  onClick={() => onRemoveEpisode(series.id, ep.projectId)}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '14px', padding: '0 4px' }}
                  title="Unlink episode"
                >×</button>
              </div>
            );
          })}
        </div>
      )}

      {series.storySummary && (
        <div style={s.summary}>
          <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 4, color: 'var(--accent-purple)' }}>Story so far</div>
          {series.storySummary.slice(0, 200)}{series.storySummary.length > 200 ? '...' : ''}
        </div>
      )}

      <button
        className="btn-secondary"
        style={{ fontSize: '12px', padding: '6px 12px', alignSelf: 'flex-start' }}
        onClick={() => onAddEpisode(series)}
      >
        + Add Episode
      </button>
    </div>
  );
}

export default function SeriesPage() {
  const navigate = useNavigate();
  const [seriesList, setSeriesList] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [addEpisodeModal, setAddEpisodeModal] = useState(null); // series object
  const [selectedProject, setSelectedProject] = useState('');
  const [episodeNum, setEpisodeNum] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    Promise.all([get('/series'), get('/projects')])
      .then(([sl, pl]) => { setSeriesList(sl); setProjects(pl); })
      .finally(() => setLoading(false));
  }, []);

  async function loadSeries() {
    setSeriesList(await get('/series'));
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      const created = await post('/series', { name: newName.trim() });
      setSeriesList(prev => [...prev, created]);
      setNewName('');
      setShowCreate(false);
    } catch (e) { setErr(e.message); }
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this series? Episodes will be unlinked but not deleted.')) return;
    await del(`/series/${id}`);
    setSeriesList(prev => prev.filter(s => s.id !== id));
  }

  async function handleAddEpisode() {
    if (!selectedProject) return;
    try {
      await post(`/series/${addEpisodeModal.id}/episodes`, {
        projectId: selectedProject,
        episodeNumber: episodeNum ? Number(episodeNum) : undefined,
      });
      setAddEpisodeModal(null);
      setSelectedProject('');
      setEpisodeNum('');
      await loadSeries();
    } catch (e) { setErr(e.message); }
  }

  async function handleRemoveEpisode(seriesId, projectId) {
    await del(`/series/${seriesId}/episodes/${projectId}`);
    await loadSeries();
  }

  // Projects not yet in this series
  const availableProjects = (series) => {
    const linked = new Set((series.episodes || []).map(e => e.projectId));
    return projects.filter(p => !linked.has(p.id));
  };

  return (
    <div style={s.page} className="fade-in">
      <div style={s.header}>
        <h1 style={s.title} className="gradient-text">Series</h1>
        <button className="btn-primary" onClick={() => { setShowCreate(true); setErr(''); }}>+ New Series</button>
      </div>

      {err && <div style={s.err}>{err}</div>}

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '14px' }} className="pulse">Loading...</div>
      ) : seriesList.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '80px 20px', color: 'var(--text-muted)', fontSize: '14px' }}>
          No series yet. Create one and link your episode projects to maintain story continuity.
        </div>
      ) : (
        <div style={s.grid}>
          {seriesList.map(series => (
            <SeriesCard
              key={series.id}
              series={series}
              projects={projects}
              onDelete={() => handleDelete(series.id)}
              onAddEpisode={(ser) => { setAddEpisodeModal(ser); setErr(''); }}
              onRemoveEpisode={handleRemoveEpisode}
              onClick={() => {}}
            />
          ))}
        </div>
      )}

      {/* Create series modal */}
      {showCreate && (
        <div style={s.overlay} onClick={e => e.target === e.currentTarget && setShowCreate(false)}>
          <div style={s.modal} className="fade-in">
            <div style={s.modalTitle}>New Series</div>
            <div>
              <label>Series Name</label>
              <input
                autoFocus
                placeholder="e.g. Solo Leveling"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setShowCreate(false); }}
              />
            </div>
            <div style={s.modalActions}>
              <button className="btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="btn-primary" onClick={handleCreate} disabled={!newName.trim()}>Create</button>
            </div>
          </div>
        </div>
      )}

      {/* Add episode modal */}
      {addEpisodeModal && (
        <div style={s.overlay} onClick={e => e.target === e.currentTarget && setAddEpisodeModal(null)}>
          <div style={s.modal} className="fade-in">
            <div style={s.modalTitle}>Add Episode to "{addEpisodeModal.name}"</div>
            <div>
              <label>Project</label>
              <select value={selectedProject} onChange={e => setSelectedProject(e.target.value)}>
                <option value="">Select a project...</option>
                {availableProjects(addEpisodeModal).map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label>Episode Number (optional — auto if blank)</label>
              <input
                type="number"
                min="1"
                placeholder={`Auto (${(addEpisodeModal.episodes?.length ?? 0) + 1})`}
                value={episodeNum}
                onChange={e => setEpisodeNum(e.target.value)}
              />
            </div>
            <div style={s.modalActions}>
              <button className="btn-secondary" onClick={() => setAddEpisodeModal(null)}>Cancel</button>
              <button className="btn-primary" onClick={handleAddEpisode} disabled={!selectedProject}>Add</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
