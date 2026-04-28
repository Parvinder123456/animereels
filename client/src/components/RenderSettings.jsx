import React, { useState } from 'react';

const FORMAT_OPTIONS = [
  {
    value: 'manga',
    label: 'Manga',
    description: 'Grid layout, zooms into each panel',
  },
  {
    value: 'webtoon',
    label: 'Manhwa / Webtoon',
    description: 'Tall strips, camera scrolls top-to-bottom',
  },
];

const DURATION_OPTIONS = [
  { label: '30s', value: 30 },
  { label: '1 min', value: 60 },
  { label: '5 min', value: 300 },
  { label: '15 min', value: 900 },
  { label: '30 min', value: 1800 },
  { label: 'Custom', value: 'custom' },
];

const DETAIL_OPTIONS = [
  {
    value: 'low',
    label: 'Low',
    description: 'Fewer panels, faster render, smaller file',
  },
  {
    value: 'medium',
    label: 'Medium',
    description: 'Balanced quality and speed',
  },
  {
    value: 'high',
    label: 'High',
    description: 'More panels, better quality, slower render',
  },
];

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  },
  sectionLabel: {
    fontSize: '14px',
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: '8px',
  },
  sectionHint: {
    fontSize: '12px',
    color: 'var(--text-muted)',
    marginBottom: '8px',
  },
  segmentGroup: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
  },
  segmentBtn: {
    padding: '8px 16px',
    borderRadius: '8px',
    border: '1px solid var(--glass-border)',
    background: 'var(--bg-secondary)',
    color: 'var(--text-secondary)',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  segmentBtnActive: {
    padding: '8px 16px',
    borderRadius: '8px',
    border: '1px solid var(--accent)',
    background: 'var(--accent-gradient)',
    color: 'white',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  customInput: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginTop: '8px',
  },
  numberInput: {
    width: '80px',
    padding: '6px 10px',
    borderRadius: '6px',
    border: '1px solid var(--glass-border)',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    fontSize: '13px',
  },
  detailCard: {
    padding: '12px 16px',
    borderRadius: '10px',
    border: '1px solid var(--glass-border)',
    background: 'var(--bg-secondary)',
    cursor: 'pointer',
    transition: 'all 0.2s',
    flex: '1 1 0',
    minWidth: '140px',
  },
  detailCardActive: {
    padding: '12px 16px',
    borderRadius: '10px',
    border: '1px solid var(--accent)',
    background: 'rgba(139, 92, 246, 0.1)',
    cursor: 'pointer',
    transition: 'all 0.2s',
    flex: '1 1 0',
    minWidth: '140px',
  },
  detailLabel: {
    fontSize: '14px',
    fontWeight: 600,
    marginBottom: '4px',
  },
  detailDesc: {
    fontSize: '12px',
    color: 'var(--text-muted)',
  },
};

export default function RenderSettings({ duration, detail, format, onDurationChange, onDetailChange, onFormatChange }) {
  const [customMinutes, setCustomMinutes] = useState(
    typeof duration === 'number' && !DURATION_OPTIONS.some(o => o.value === duration)
      ? Math.round(duration / 60)
      : 3
  );

  const isCustom = typeof duration === 'number' &&
    !DURATION_OPTIONS.slice(0, -1).some(o => o.value === duration);

  const selectedDurationValue = isCustom ? 'custom' : duration;
  const activeFormat = format || 'manga';

  function handleDurationClick(opt) {
    if (opt.value === 'custom') {
      onDurationChange(customMinutes * 60);
    } else {
      onDurationChange(opt.value);
    }
  }

  function handleCustomMinutesChange(e) {
    const mins = Math.max(0.5, Math.min(120, parseFloat(e.target.value) || 1));
    setCustomMinutes(mins);
    onDurationChange(Math.round(mins * 60));
  }

  return (
    <div style={styles.container}>
      {/* Format Type selector */}
      <div>
        <div style={styles.sectionLabel}>Format Type</div>
        <div style={styles.sectionHint}>
          Choose the source format. Webtoon mode scrolls vertically through tall strips.
        </div>
        <div style={styles.segmentGroup}>
          {FORMAT_OPTIONS.map(opt => (
            <div
              key={opt.value}
              style={opt.value === activeFormat ? styles.detailCardActive : styles.detailCard}
              onClick={() => onFormatChange && onFormatChange(opt.value)}
            >
              <div style={{
                ...styles.detailLabel,
                color: opt.value === activeFormat ? 'var(--accent)' : 'var(--text-primary)',
              }}>
                {opt.label}
              </div>
              <div style={styles.detailDesc}>{opt.description}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Duration selector */}
      <div>
        <div style={styles.sectionLabel}>Video Duration</div>
        <div style={styles.sectionHint}>
          Target length of the final video. Audio will be padded or compressed to fit.
        </div>
        <div style={styles.segmentGroup}>
          {DURATION_OPTIONS.map(opt => (
            <button
              key={opt.label}
              style={
                (opt.value === 'custom' ? isCustom : opt.value === duration)
                  ? styles.segmentBtnActive
                  : styles.segmentBtn
              }
              onClick={() => handleDurationClick(opt)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {isCustom && (
          <div style={styles.customInput}>
            <input
              type="number"
              min="0.5"
              max="120"
              step="0.5"
              value={customMinutes}
              onChange={handleCustomMinutesChange}
              style={styles.numberInput}
            />
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>minutes</span>
          </div>
        )}
      </div>

      {/* Detail selector */}
      <div>
        <div style={styles.sectionLabel}>Detail Level</div>
        <div style={styles.sectionHint}>
          Controls panel density, narration depth, and encoding quality.
        </div>
        <div style={styles.segmentGroup}>
          {DETAIL_OPTIONS.map(opt => (
            <div
              key={opt.value}
              style={opt.value === detail ? styles.detailCardActive : styles.detailCard}
              onClick={() => onDetailChange(opt.value)}
            >
              <div style={{
                ...styles.detailLabel,
                color: opt.value === detail ? 'var(--accent)' : 'var(--text-primary)',
              }}>
                {opt.label}
              </div>
              <div style={styles.detailDesc}>{opt.description}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
