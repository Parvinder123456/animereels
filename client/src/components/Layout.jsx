import React, { useEffect, useState, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { get, post } from '../api/client.js';

const styles = {
  nav: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 32px',
    borderBottom: '1px solid var(--glass-border)',
    background: 'rgba(10, 14, 26, 0.8)',
    backdropFilter: 'blur(12px)',
    position: 'sticky',
    top: 0,
    zIndex: 100
  },
  logo: {
    fontSize: '20px',
    fontWeight: 700,
    letterSpacing: '-0.5px'
  },
  links: {
    display: 'flex',
    gap: '24px',
    alignItems: 'center'
  },
  navLink: {
    color: 'var(--text-secondary)',
    fontSize: '14px',
    textDecoration: 'none',
    transition: 'color 0.2s'
  },
  main: {
    maxWidth: '1200px',
    margin: '0 auto',
    padding: '32px'
  }
};

function BackendOption({ name, subtitle, active, color, onClick, saving }) {
  return (
    <button
      onClick={onClick}
      disabled={active || saving}
      style={{
        display: 'flex', flexDirection: 'column',
        width: '100%', padding: '8px 12px', border: 'none',
        background: active ? `${color}18` : 'transparent',
        color: 'var(--text-primary)', cursor: active ? 'default' : 'pointer',
        textAlign: 'left', gap: '2px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '12px', fontWeight: 500 }}>{name}</span>
        {active && <span style={{ fontSize: '10px', color }}> active</span>}
      </div>
      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{subtitle}</span>
    </button>
  );
}

function BackendSection({ label, current, onSwitch, saving, settings }) {
  return (
    <>
      <div style={{ padding: '8px 12px 4px', fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
        {label}
      </div>
      <BackendOption
        name="Gemini Cloud"
        subtitle={`${settings.gemini.model} · ${settings.gemini.hasApiKey ? 'key set' : 'no key'}`}
        active={current === 'gemini'} color="var(--accent-purple)"
        onClick={() => onSwitch('gemini')} saving={saving}
      />
      <div style={{ height: '1px', background: 'var(--glass-border)', margin: '0 8px' }} />
      <BackendOption
        name="Groq Cloud"
        subtitle={`${label === 'Vision AI' ? settings.groq.visionModel.split('/').pop() : settings.groq.textModel} · ${settings.groq.hasApiKey ? 'key set' : 'no key'}`}
        active={current === 'groq'} color="#f97316"
        onClick={() => onSwitch('groq')} saving={saving}
      />
      <div style={{ height: '1px', background: 'var(--glass-border)', margin: '0 8px' }} />
      <BackendOption
        name="Local (Ollama)"
        subtitle={`${label === 'Vision AI' ? settings.ollama.model : settings.ollama.textModel} · no filters`}
        active={current === 'ollama'} color="#34d399"
        onClick={() => onSwitch('ollama')} saving={saving}
      />
    </>
  );
}

function AIBackendDropdown() {
  const [settings, setSettings] = useState(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    get('/settings').then(setSettings).catch(() => {});
  }, []);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  async function switchVision(backend) {
    setSaving(true);
    try { setSettings(await post('/settings', { visionBackend: backend })); } catch {}
    setSaving(false);
  }

  async function switchText(backend) {
    setSaving(true);
    try { setSettings(await post('/settings', { textBackend: backend })); } catch {}
    setSaving(false);
  }

  if (!settings) return null;

  const vb = settings.visionBackend;
  const tb = settings.textBackend;
  const bothGroq  = vb === 'groq'  && tb === 'groq';
  const bothLocal = vb === 'ollama' && tb === 'ollama';
  const bothGemini= vb === 'gemini' && tb === 'gemini';
  const accentColor = bothLocal ? '#34d399' : bothGroq ? '#f97316' : bothGemini ? 'var(--accent-purple)' : '#f59e0b';
  const accentBg    = bothLocal ? 'rgba(52,211,153,0.12)' : bothGroq ? 'rgba(249,115,22,0.12)' : bothGemini ? 'rgba(139,92,246,0.12)' : 'rgba(245,158,11,0.12)';
  const accentBorder= bothLocal ? 'rgba(52,211,153,0.3)'  : bothGroq ? 'rgba(249,115,22,0.3)'  : bothGemini ? 'rgba(139,92,246,0.3)'  : 'rgba(245,158,11,0.3)';
  const label = bothLocal ? 'Full Local' : bothGroq ? 'Groq' : bothGemini ? 'Gemini' : 'Mixed';

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={saving}
        style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          fontSize: '11px', padding: '4px 10px', borderRadius: '20px',
          background: accentBg, color: accentColor, border: `1px solid ${accentBorder}`,
          fontWeight: 500, cursor: 'pointer', letterSpacing: '0.3px',
          transition: 'opacity 0.15s', opacity: saving ? 0.6 : 1,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: accentColor, flexShrink: 0, boxShadow: `0 0 6px ${accentColor}` }} />
        {saving ? 'Saving...' : `AI · ${label}`}
        <span style={{ fontSize: '9px', marginLeft: 2 }}>▼</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 'calc(100% + 8px)',
          background: 'var(--bg-secondary, #0f1729)', border: '1px solid var(--glass-border)',
          borderRadius: '10px', minWidth: '220px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          overflow: 'hidden', zIndex: 200,
        }}>
          <BackendSection
            label="Vision AI"
            current={settings.visionBackend}
            onSwitch={switchVision}
            saving={saving}
            settings={settings}
          />

          <div style={{ height: '1px', background: 'var(--glass-border)', margin: '4px 0' }} />

          <BackendSection
            label="Text AI"
            current={settings.textBackend}
            onSwitch={switchText}
            saving={saving}
            settings={settings}
          />

          <div style={{ padding: '6px 12px 8px', fontSize: '10px', color: 'var(--text-muted)', borderTop: '1px solid var(--glass-border)', marginTop: 4 }}>
            Switch takes effect on next job run
          </div>
        </div>
      )}
    </div>
  );
}

export default function Layout({ children }) {
  const location = useLocation();

  return (
    <div>
      <nav style={styles.nav}>
        <Link to="/" style={{ textDecoration: 'none' }}>
          <span style={styles.logo} className="gradient-text">AnimeReels</span>
        </Link>
        <div style={styles.links}>
          <Link
            to="/"
            style={{ ...styles.navLink, color: location.pathname === '/' ? 'var(--text-primary)' : 'var(--text-secondary)' }}
          >
            Dashboard
          </Link>
          <Link
            to="/series"
            style={{ ...styles.navLink, color: location.pathname === '/series' ? 'var(--text-primary)' : 'var(--text-secondary)' }}
          >
            Series
          </Link>
          <AIBackendDropdown />
        </div>
      </nav>
      <main style={styles.main}>
        {children}
      </main>
    </div>
  );
}
