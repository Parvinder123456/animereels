/**
 * Detail-level presets controlling panel density, encoding quality, and narration depth.
 *
 * panelsPerMinute: target panel density
 * crf: libx264 CRF value (lower = better quality)
 * cq: h264_nvenc constant-quality value
 * preset: libx264 preset name
 * narrationStyle: hint for script generation (not used in encoding)
 */
export const DETAIL_PRESETS = {
  low: {
    panelsPerMinute: 4,       // ~1 panel per 15s
    crf: 26,
    cq: 28,
    preset: 'fast',
    narrationStyle: 'brief',
    label: 'Low',
    description: 'Fewer panels, faster render, smaller file',
  },
  medium: {
    panelsPerMinute: 7.5,     // ~1 panel per 8s
    crf: 20,
    cq: 22,
    preset: 'medium',
    narrationStyle: 'normal',
    label: 'Medium',
    description: 'Balanced quality and speed',
  },
  high: {
    panelsPerMinute: 15,      // ~1 panel per 4s
    crf: 16,
    cq: 18,
    preset: 'slow',
    narrationStyle: 'rich',
    label: 'High',
    description: 'More panels, better quality, slower render',
  },
};

/**
 * Duration presets in seconds. "custom" means the user provides their own value.
 */
export const DURATION_OPTIONS = [
  { label: '30s', value: 30 },
  { label: '1 min', value: 60 },
  { label: '5 min', value: 300 },
  { label: '15 min', value: 900 },
  { label: '30 min', value: 1800 },
  { label: 'Custom', value: 'custom' },
];

/**
 * Get the resolved preset for a detail level string.
 */
export function getDetailPreset(detail = 'medium') {
  return DETAIL_PRESETS[detail] || DETAIL_PRESETS.medium;
}
