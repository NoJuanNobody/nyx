import { useState, useEffect } from 'react';
import { STAGES, CONNECTORS } from '../lib/stages';

interface LifecycleExplorerProps {
  mode?: 'dashboard' | 'onboarding';
  onComplete?: () => void;
  initialPhase?: number;
}

export function LifecycleExplorer({
  mode = 'dashboard',
  onComplete,
  initialPhase = 0,
}: LifecycleExplorerProps) {
  const [active, setActive] = useState(initialPhase);
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href =
      'https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap';
    document.head.appendChild(link);
    setTimeout(() => setAnimated(true), 100);
  }, []);

  const stage = STAGES[active];
  const isLastPhase = active === STAGES.length - 1;

  return (
    <div
      style={{
        background: '#080C10',
        minHeight: '100vh',
        color: '#E2E8F0',
        fontFamily: "'Syne', sans-serif",
        padding: '36px 28px',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Background grain texture */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          opacity: 0.03,
          pointerEvents: 'none',
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'repeat',
          backgroundSize: '128px',
        }}
      />

      {/* Ambient glow behind active stage */}
      <div
        style={{
          position: 'fixed',
          top: '30%',
          left: '50%',
          transform: 'translateX(-50%)',
          width: 600,
          height: 600,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${stage.hex}08 0%, transparent 70%)`,
          pointerEvents: 'none',
          transition: 'background 0.6s ease',
        }}
      />

      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: 48, position: 'relative' }}>
        {mode === 'onboarding' && (
          <button
            data-testid="skip-intro"
            onClick={onComplete}
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              background: 'transparent',
              border: 'none',
              color: '#64748B',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              cursor: 'pointer',
              textDecoration: 'underline',
              padding: 0,
            }}
          >
            Skip intro
          </button>
        )}
        <div
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            color: stage.hex,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            marginBottom: 10,
            transition: 'color 0.4s',
          }}
        >
          Product Lifecycle
        </div>
        <div
          style={{
            fontSize: 36,
            fontWeight: 800,
            letterSpacing: '-0.02em',
            lineHeight: 1,
          }}
        >
          Sync
          <span style={{ color: stage.hex, transition: 'color 0.4s' }}>Docs</span>
        </div>
        <div
          style={{
            fontSize: 13,
            color: '#64748B',
            marginTop: 8,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          From first idea to living codebase.
        </div>
      </div>

      {/* Stage rail */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 0,
          marginBottom: 40,
          position: 'relative',
        }}
      >
        {STAGES.map((s, i) => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center' }}>
            {/* Node */}
            <button
              data-testid={`stage-node-${i}`}
              aria-label={`Go to stage ${s.label}`}
              onClick={() => setActive(i)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                cursor: 'pointer',
                gap: 8,
                padding: '0 4px',
                background: 'transparent',
                border: 'none',
              }}
            >
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: '50%',
                  border: `2px solid ${active === i ? s.hex : '#1E293B'}`,
                  background: active === i ? `${s.hex}18` : '#0D1520',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 20,
                  color: active === i ? s.hex : '#334155',
                  transition: 'all 0.3s ease',
                  boxShadow: active === i ? `0 0 20px ${s.hex}30` : 'none',
                }}
              >
                {s.icon}
              </div>
              <div
                style={{
                  fontSize: 10,
                  fontFamily: "'JetBrains Mono', monospace",
                  color: active === i ? s.hex : '#475569',
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  transition: 'color 0.3s',
                  textAlign: 'center',
                  maxWidth: 64,
                }}
              >
                {s.label}
              </div>
            </button>

            {/* Connector line */}
            {i < STAGES.length - 1 && (
              <div
                style={{
                  width: 40,
                  height: 1,
                  background:
                    i < active
                      ? `linear-gradient(90deg, ${STAGES[i].hex}, ${STAGES[i + 1].hex})`
                      : '#1E293B',
                  transition: 'background 0.4s',
                  marginBottom: 22,
                  flexShrink: 0,
                }}
              />
            )}
          </div>
        ))}
      </div>

      {/* Main detail card */}
      <div
        data-testid="detail-card"
        style={{
          maxWidth: 720,
          margin: '0 auto',
          background: '#0D1520',
          border: `1px solid ${stage.hex}30`,
          borderRadius: 16,
          overflow: 'hidden',
          transition: 'border-color 0.4s',
          boxShadow: `0 0 40px ${stage.hex}08`,
        }}
      >
        {/* Card header */}
        <div
          style={{
            padding: '24px 28px 20px',
            borderBottom: `1px solid ${stage.hex}20`,
            background: `linear-gradient(135deg, ${stage.hex}0A, transparent)`,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  color: stage.hex,
                  letterSpacing: '0.15em',
                  textTransform: 'uppercase',
                  marginBottom: 6,
                }}
              >
                Phase {active + 1} of {STAGES.length}
              </div>
              <div
                data-testid="phase-heading"
                style={{
                  fontSize: 28,
                  fontWeight: 800,
                  letterSpacing: '-0.02em',
                  color: '#F1F5F9',
                }}
              >
                {stage.subtitle}
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: '#64748B',
                  marginTop: 4,
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {stage.who}
              </div>
            </div>
            <div
              style={{
                fontSize: 40,
                color: stage.hex,
                opacity: 0.4,
                transition: 'color 0.4s',
              }}
            >
              {stage.icon}
            </div>
          </div>
          <div
            style={{
              fontSize: 14,
              color: '#94A3B8',
              marginTop: 14,
              lineHeight: 1.65,
            }}
          >
            {stage.description}
          </div>
        </div>

        {/* Documents */}
        <div style={{ padding: '20px 28px', borderBottom: '1px solid #0F1923' }}>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              color: '#475569',
              textTransform: 'uppercase',
              letterSpacing: '0.15em',
              marginBottom: 12,
            }}
          >
            Documents at this stage
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {stage.docs.map((doc, i) => (
              <div
                key={i}
                style={{
                  background: `${stage.hex}10`,
                  border: `1px solid ${stage.hex}25`,
                  borderRadius: 6,
                  padding: '5px 12px',
                  fontSize: 12,
                  color: stage.hex,
                  fontFamily: "'JetBrains Mono', monospace",
                  transition: 'all 0.3s',
                }}
              >
                {doc}
              </div>
            ))}
          </div>
        </div>

        {/* AI layer */}
        <div style={{ padding: '20px 28px', borderBottom: '1px solid #0F1923' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div
              style={{
                background: `${stage.hex}15`,
                border: `1px solid ${stage.hex}30`,
                borderRadius: 8,
                padding: '10px 14px',
                flex: 1,
              }}
            >
              <div
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 10,
                  color: stage.hex,
                  textTransform: 'uppercase',
                  letterSpacing: '0.15em',
                  marginBottom: 6,
                }}
              >
                ✦ Claude AI at this stage
              </div>
              <div
                data-testid="ai-panel-text"
                style={{ fontSize: 13, color: '#94A3B8', lineHeight: 1.6 }}
              >
                {stage.ai}
              </div>
            </div>
          </div>
        </div>

        {/* Output */}
        <div style={{ padding: '16px 28px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                color: '#475569',
                textTransform: 'uppercase',
                letterSpacing: '0.15em',
                whiteSpace: 'nowrap',
              }}
            >
              Output →
            </div>
            <div
              data-testid="output-text"
              style={{
                fontSize: 13,
                color: '#E2E8F0',
                fontWeight: 600,
              }}
            >
              {stage.output}
            </div>
          </div>
        </div>
      </div>

      {/* Connector pill */}
      {!isLastPhase && (
        <div
          data-testid="connector-pill"
          style={{
            maxWidth: 720,
            margin: '16px auto 0',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              background: '#0D1520',
              border: '1px solid #1E293B',
              borderRadius: 999,
              padding: '6px 16px',
            }}
          >
            <span style={{ color: stage.hex, fontSize: 12 }}>↓</span>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                color: '#475569',
              }}
            >
              {CONNECTORS[active]}
            </span>
          </div>
        </div>
      )}

      {/* Nav buttons */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: 12,
          marginTop: 28,
        }}
      >
        <button
          data-testid="prev-button"
          aria-label="Previous phase"
          onClick={() => setActive(Math.max(0, active - 1))}
          disabled={active === 0}
          style={{
            background: 'transparent',
            border: '1px solid #1E293B',
            borderRadius: 8,
            padding: '8px 20px',
            color: active === 0 ? '#1E293B' : '#64748B',
            cursor: active === 0 ? 'not-allowed' : 'pointer',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            transition: 'all 0.2s',
          }}
        >
          ← prev
        </button>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {STAGES.map((_, i) => (
            <button
              key={i}
              data-testid={`dot-${i}`}
              aria-label={`Go to phase ${i + 1}`}
              onClick={() => setActive(i)}
              style={{
                width: active === i ? 20 : 6,
                height: 6,
                borderRadius: 3,
                background: active === i ? stage.hex : '#1E293B',
                cursor: 'pointer',
                transition: 'all 0.3s',
                border: 'none',
                padding: 0,
              }}
            />
          ))}
        </div>

        {mode === 'onboarding' && isLastPhase ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              data-testid="start-cta"
              onClick={onComplete}
              style={{
                background: `${stage.hex}15`,
                border: `1px solid ${stage.hex}40`,
                borderRadius: 8,
                padding: '8px 20px',
                color: stage.hex,
                cursor: 'pointer',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
                transition: 'all 0.3s',
              }}
            >
              Start with {stage.subtitle} →
            </button>
            <button
              data-testid="skip-to-editor"
              onClick={onComplete}
              style={{
                background: 'transparent',
                border: '1px solid #1E293B',
                borderRadius: 8,
                padding: '8px 20px',
                color: '#64748B',
                cursor: 'pointer',
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
                transition: 'all 0.2s',
              }}
            >
              Skip to editor →
            </button>
          </div>
        ) : (
          <button
            data-testid="next-button"
            aria-label="Next phase"
            onClick={() => setActive(Math.min(STAGES.length - 1, active + 1))}
            disabled={isLastPhase}
            style={{
              background: isLastPhase ? 'transparent' : `${stage.hex}15`,
              border: `1px solid ${isLastPhase ? '#1E293B' : stage.hex + '40'}`,
              borderRadius: 8,
              padding: '8px 20px',
              color: isLastPhase ? '#1E293B' : stage.hex,
              cursor: isLastPhase ? 'not-allowed' : 'pointer',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              transition: 'all 0.3s',
            }}
          >
            next →
          </button>
        )}
      </div>

      {/* Footer note */}
      <div
        style={{
          textAlign: 'center',
          marginTop: 32,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: '#1E293B',
        }}
      >
        Every stage versioned · Every change traceable · Full rollback at any point
      </div>
    </div>
  );
}
