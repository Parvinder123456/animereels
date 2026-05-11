import React from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useProject } from '../hooks/useProject.js';
import VideoPreview from '../components/VideoPreview.jsx';

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
  titleRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '16px',
    flexWrap: 'wrap'
  },
  projectName: {
    fontSize: '26px',
    fontWeight: 700,
    letterSpacing: '-0.5px'
  },
  createdDate: {
    fontSize: '13px',
    color: 'var(--text-muted)',
    marginTop: '4px'
  },
  headerActions: {
    display: 'flex',
    gap: '12px',
    alignItems: 'center',
    flexShrink: 0
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap: '16px'
  },
  statCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '20px',
    background: 'var(--glass-bg)',
    border: '1px solid var(--glass-border)',
    borderRadius: '12px'
  },
  statLabel: {
    fontSize: '11px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    color: 'var(--text-muted)',
    fontWeight: 600
  },
  statValue: {
    fontSize: '24px',
    fontWeight: 700,
    color: 'var(--text-primary)'
  },
  statUnit: {
    fontSize: '12px',
    color: 'var(--text-muted)'
  },
  sectionTitle: {
    fontSize: '16px',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    marginBottom: '16px'
  },
  notRendered: {
    padding: '48px 24px',
    textAlign: 'center',
    background: 'var(--glass-bg)',
    border: '1px solid var(--glass-border)',
    borderRadius: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    alignItems: 'center'
  },
  notRenderedText: {
    fontSize: '16px',
    fontWeight: 600,
    color: 'var(--text-secondary)'
  },
  notRenderedSub: {
    fontSize: '14px',
    color: 'var(--text-muted)'
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

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric'
  });
}

function StatCard({ label, value, unit }) {
  if (!value && value !== 0) return null;
  return (
    <div style={styles.statCard}>
      <span style={styles.statLabel}>{label}</span>
      <span style={styles.statValue}>{value}</span>
      {unit && <span style={styles.statUnit}>{unit}</span>}
    </div>
  );
}

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { project, loading, error } = useProject(id);

  if (loading && !project) {
    return (
      <div style={styles.page}>
        <div style={{ color: 'var(--text-muted)', fontSize: '14px' }} className="pulse">
          Loading project...
        </div>
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

  const stats = project?.stats || {};
  const isRendered = project?.state?.render === 'complete';

  return (
    <div style={styles.page} className="fade-in">
      <div style={styles.pageHeader}>
        <Link to="/" style={styles.backLink}>Back to Dashboard</Link>
        <div style={styles.titleRow}>
          <div>
            <h1 style={styles.projectName} className="gradient-text">
              {project?.name}
            </h1>
            {project?.createdAt && (
              <div style={styles.createdDate}>Created {formatDate(project.createdAt)}</div>
            )}
          </div>
          <div style={styles.headerActions}>
            <button
              className="btn-secondary"
              onClick={() => {
                const type = project?.config?.projectType;
                if (type === 'shorts') navigate(`/projects/${id}/shorts`);
                else if (type === 'translate') navigate(`/projects/${id}/translate`);
                else if (type === 'video_summary') navigate(`/projects/${id}/video`);
                else navigate(`/projects/${id}`);
              }}
            >
              Edit / Re-render
            </button>
          </div>
        </div>
      </div>

      <div>
        <div style={styles.sectionTitle}>Project Stats</div>
        <div style={styles.statsGrid}>
          <StatCard label="Panels" value={stats.panelCount || 0} />
          <StatCard label="Script Words" value={stats.scriptWordCount || 0} />
          {stats.audioDurationSec > 0 && (
            <StatCard label="Audio" value={stats.audioDurationSec} unit="seconds" />
          )}
          {stats.videoDurationSec > 0 && (
            <StatCard label="Video" value={stats.videoDurationSec} unit="seconds" />
          )}
          {stats.pageCount > 0 && (
            <StatCard label="Pages" value={stats.pageCount} />
          )}
          {stats.chapterCount > 0 && (
            <StatCard label="Chapters" value={stats.chapterCount} />
          )}
        </div>
      </div>

      <div>
        <div style={styles.sectionTitle}>Final Video</div>
        {isRendered ? (
          <VideoPreview projectId={id} project={project} />
        ) : (
          <div style={styles.notRendered}>
            <div style={styles.notRenderedText}>Video not rendered yet</div>
            <div style={styles.notRenderedSub}>
              Complete all steps in the wizard to generate your video.
            </div>
            <button
              className="btn-primary"
              onClick={() => navigate(`/projects/${id}`)}
            >
              Go to Wizard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
