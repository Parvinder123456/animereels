import React from 'react';

const styles = {
  container: {
    padding: '16px',
    borderRadius: '10px',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--glass-border)'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '10px'
  },
  step: {
    fontSize: '13px',
    fontWeight: 600,
    color: 'var(--accent-cyan)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px'
  },
  percent: {
    fontSize: '13px',
    color: 'var(--text-muted)'
  },
  message: {
    fontSize: '13px',
    color: 'var(--text-secondary)',
    marginBottom: '10px'
  },
  barOuter: {
    height: '4px',
    background: 'var(--bg-primary)',
    borderRadius: '2px',
    overflow: 'hidden'
  },
  barInner: {
    height: '100%',
    background: 'var(--accent-gradient)',
    borderRadius: '2px',
    transition: 'width 0.4s ease'
  }
};

export default function ProgressTracker({ progress }) {
  if (!progress || progress.step === 'connected') return null;

  const percent = Math.max(0, Math.min(100, progress.percent || 0));
  const isError = progress.percent === -1;

  return (
    <div style={styles.container} className="fade-in">
      <div style={styles.header}>
        <span style={{
          ...styles.step,
          color: isError ? 'var(--error)' : 'var(--accent-cyan)'
        }}>
          {progress.step}
        </span>
        {!isError && <span style={styles.percent}>{percent}%</span>}
      </div>
      <div style={styles.message}>{progress.message}</div>
      {!isError && (
        <div style={styles.barOuter}>
          <div style={{ ...styles.barInner, width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}
