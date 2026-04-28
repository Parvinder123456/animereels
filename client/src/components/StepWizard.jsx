import React from 'react';

const STEPS = [
  { key: 'upload', label: 'Upload', num: 1 },
  { key: 'script', label: 'Script', num: 2 },
  { key: 'voice', label: 'Voice', num: 3 },
  { key: 'render', label: 'Render', num: 4 }
];

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '32px'
  },
  stepper: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0'
  },
  stepItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px'
  },
  circle: {
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '14px',
    fontWeight: 600,
    flexShrink: 0,
    transition: 'all 0.3s'
  },
  label: {
    fontSize: '13px',
    fontWeight: 500,
    transition: 'color 0.3s'
  },
  connector: {
    width: '60px',
    height: '2px',
    margin: '0 8px',
    transition: 'background 0.3s'
  },
  nav: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  }
};

function getStepStyle(stepKey, currentStep, projectState) {
  const state = projectState?.[stepKey];
  const stepIndex = STEPS.findIndex(s => s.key === stepKey);
  const currentIndex = STEPS.findIndex(s => s.key === currentStep);

  if (state === 'complete') {
    return {
      circle: {
        ...styles.circle,
        background: 'var(--success)',
        color: 'white'
      },
      label: { ...styles.label, color: 'var(--success)' }
    };
  }
  if (state === 'error') {
    return {
      circle: {
        ...styles.circle,
        background: 'var(--error)',
        color: 'white'
      },
      label: { ...styles.label, color: 'var(--error)' }
    };
  }
  if (stepKey === currentStep) {
    return {
      circle: {
        ...styles.circle,
        background: 'var(--accent-gradient)',
        color: 'white'
      },
      label: { ...styles.label, color: 'var(--text-primary)' }
    };
  }
  return {
    circle: {
      ...styles.circle,
      background: 'var(--bg-secondary)',
      color: 'var(--text-muted)',
      border: '1px solid var(--glass-border)'
    },
    label: { ...styles.label, color: 'var(--text-muted)' }
  };
}

export default function StepWizard({ currentStep, onStepChange, projectState, autoRun, uploadDone, pipelineStarted, onStart, children }) {
  const currentIndex = STEPS.findIndex(s => s.key === currentStep);

  function canGoTo(stepKey) {
    const idx = STEPS.findIndex(s => s.key === stepKey);
    if (idx === 0) return true;
    // Can go to step if previous step is complete
    const prevStep = STEPS[idx - 1];
    return projectState?.[prevStep.key] === 'complete';
  }

  return (
    <div style={styles.container}>
      {/* Step indicator */}
      <div style={styles.stepper}>
        {STEPS.map((step, i) => {
          const stepStyle = getStepStyle(step.key, currentStep, projectState);
          return (
            <React.Fragment key={step.key}>
              <div
                style={{ ...styles.stepItem, cursor: canGoTo(step.key) ? 'pointer' : 'default' }}
                onClick={() => canGoTo(step.key) && onStepChange(step.key)}
              >
                <div style={stepStyle.circle}>
                  {projectState?.[step.key] === 'complete' ? '\u2713' : step.num}
                </div>
                <span style={stepStyle.label}>{step.label}</span>
              </div>
              {i < STEPS.length - 1 && (
                <div style={{
                  ...styles.connector,
                  background: projectState?.[STEPS[i].key] === 'complete'
                    ? 'var(--success)' : 'var(--glass-border)'
                }} />
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* Step content */}
      <div className="fade-in">
        {children}
      </div>

      {/* Navigation */}
      {autoRun ? (
        <div style={styles.nav}>
          {currentIndex > 0 ? (
            <button
              className="btn-secondary"
              onClick={() => onStepChange(STEPS[0].key)}
            >
              Back to Setup
            </button>
          ) : pipelineStarted ? (
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              Pipeline is running...
            </span>
          ) : (
            <button
              className="btn-primary"
              onClick={onStart}
              disabled={!uploadDone}
              title={!uploadDone ? 'Upload images first' : ''}
            >
              {uploadDone ? 'Start Pipeline' : 'Upload images to begin'}
            </button>
          )}
        </div>
      ) : (
        <div style={styles.nav}>
          <button
            className="btn-secondary"
            onClick={() => onStepChange(STEPS[Math.max(0, currentIndex - 1)].key)}
            disabled={currentIndex === 0}
          >
            Back
          </button>
          <button
            className="btn-primary"
            onClick={() => onStepChange(STEPS[Math.min(STEPS.length - 1, currentIndex + 1)].key)}
            disabled={currentIndex === STEPS.length - 1 || !canGoTo(STEPS[currentIndex + 1]?.key)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
