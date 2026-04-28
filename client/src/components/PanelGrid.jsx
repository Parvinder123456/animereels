import React, { useState, useEffect } from 'react';
import { get } from '../api/client.js';

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px'
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: '12px'
  },
  panelCard: {
    position: 'relative',
    borderRadius: '8px',
    overflow: 'hidden',
    border: '1px solid var(--glass-border)',
    background: 'var(--bg-secondary)'
  },
  panelImg: {
    width: '100%',
    height: '200px',
    objectFit: 'cover',
    display: 'block'
  },
  panelInfo: {
    padding: '8px',
    fontSize: '11px',
    color: 'var(--text-muted)',
    textAlign: 'center'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  count: {
    fontSize: '14px',
    color: 'var(--text-secondary)'
  },
  empty: {
    textAlign: 'center',
    padding: '40px 20px',
    color: 'var(--text-muted)',
    fontSize: '14px'
  }
};

export default function PanelGrid({ projectId }) {
  const [panels, setPanels] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    get(`/projects/${projectId}/panels`)
      .then(setPanels)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading) {
    return <div style={styles.empty} className="pulse">Loading panels...</div>;
  }

  if (panels.length === 0) {
    return <div style={styles.empty}>No panels yet. Upload chapters first.</div>;
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h3 style={{ fontSize: '16px', fontWeight: 600 }}>Extracted Panels</h3>
        <span style={styles.count}>{panels.length} panels</span>
      </div>
      <div style={styles.grid}>
        {panels.map((panel, i) => (
          <div key={i} style={styles.panelCard}>
            <img
              src={panel.path}
              alt={panel.filename}
              style={styles.panelImg}
              loading="lazy"
            />
            <div style={styles.panelInfo}>
              {panel.width}x{panel.height}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
