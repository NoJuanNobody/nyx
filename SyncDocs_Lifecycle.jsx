import { useState, useEffect } from "react";

const stages = [
  {
    id: 1,
    phase: "Conception",
    label: "Idea & Vision",
    icon: "◎",
    color: "#E8C547",
    docs: ["Problem Statement", "Value Proposition", "Market Opportunity", "Rough Concept Notes"],
    who: "Founder · Stakeholder · PM",
    ai: "Claude stress-tests your idea, identifies blind spots, suggests missing angles",
    description: "Where everything begins. An unstructured thought gets captured and shaped into a clear problem worth solving.",
    output: "Validated concept brief ready for product definition",
  },
  {
    id: 2,
    phase: "Definition",
    label: "Product Spec",
    icon: "◈",
    color: "#4EC9B0",
    docs: ["Product Requirements Doc (PRD)", "User Stories", "Personas", "Feature List", "Competitive Analysis"],
    who: "PM · Product Designer · Stakeholder",
    ai: "Flags ambiguous requirements, generates user stories from PRD, scores completeness",
    description: "The product takes shape. Non-technical stakeholders define what needs to be built and why.",
    output: "Structured PRD that engineering can trust",
  },
  {
    id: 3,
    phase: "Architecture",
    label: "System Design",
    icon: "◫",
    color: "#7B9FE0",
    docs: ["System Architecture Doc", "Data Models", "API Contracts", "Component Hierarchy", "Tech Stack Decisions"],
    who: "Tech Lead · Senior Engineer · Architect",
    ai: "Reviews architecture for gaps, suggests patterns, links decisions back to PRD intent",
    description: "Decisions get made. The technical foundation is designed with full traceability back to the product vision.",
    output: "Architecture docs linked to every PRD requirement they serve",
  },
  {
    id: 4,
    phase: "Implementation",
    label: "Dev Specs",
    icon: "◧",
    color: "#C084FC",
    docs: ["AI-Ready Feature Specs", "Ticket Breakdowns", "Acceptance Criteria", "Edge Cases", "Test Plans"],
    who: "Engineer · QA · Tech Lead",
    ai: "Scores spec quality for AI code generation, auto-generates tickets, suggests edge cases",
    description: "Specs are written to be consumed by AI coding agents. Every ticket traces back to a user story.",
    output: "Implementation-ready specs optimized for Claude Code & Copilot",
  },
  {
    id: 5,
    phase: "Execution",
    label: "Code & Sync",
    icon: "◉",
    color: "#F87171",
    docs: ["Living Codebase", "Auto-Updated Docs", "Drift Alerts", "Change History", "Rollback Points"],
    who: "Engineer · AI Coding Agent",
    ai: "Watches commits, detects doc-code drift in real time, flags intent violations",
    description: "Code is written — by humans or AI agents. SyncDocs watches for drift and keeps the full stack in sync.",
    output: "Codebase that never diverges silently from its original intent",
  },
];

const connectors = [
  "Concept brief seeds the PRD",
  "PRD requirements drive architecture",
  "Architecture shapes implementation specs",
  "Specs generate code via AI agents",
];

export default function SyncDocsLifecycle() {
  const [active, setActive] = useState(0);
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap";
    document.head.appendChild(link);
    setTimeout(() => setAnimated(true), 100);
  }, []);

  const stage = stages[active];

  return (
    <div style={{
      background: "#080C10",
      minHeight: "100vh",
      color: "#E2E8F0",
      fontFamily: "'Syne', sans-serif",
      padding: "36px 28px",
      position: "relative",
      overflow: "hidden",
    }}>
      {/* Background grain texture */}
      <div style={{
        position: "fixed", inset: 0, opacity: 0.03, pointerEvents: "none",
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
        backgroundRepeat: "repeat", backgroundSize: "128px",
      }} />

      {/* Glow behind active stage */}
      <div style={{
        position: "fixed", top: "30%", left: "50%", transform: "translateX(-50%)",
        width: 600, height: 600, borderRadius: "50%",
        background: `radial-gradient(circle, ${stage.color}08 0%, transparent 70%)`,
        pointerEvents: "none", transition: "background 0.6s ease",
      }} />

      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 48, position: "relative" }}>
        <div style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
          color: stage.color, letterSpacing: "0.2em", textTransform: "uppercase",
          marginBottom: 10, transition: "color 0.4s",
        }}>Product Lifecycle</div>
        <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1 }}>
          Sync<span style={{ color: stage.color, transition: "color 0.4s" }}>Docs</span>
        </div>
        <div style={{
          fontSize: 13, color: "#64748B", marginTop: 8,
          fontFamily: "'JetBrains Mono', monospace",
        }}>From first idea to living codebase.</div>
      </div>

      {/* Stage rail */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        gap: 0, marginBottom: 40, position: "relative",
      }}>
        {stages.map((s, i) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center" }}>
            {/* Node */}
            <div
              onClick={() => setActive(i)}
              style={{
                display: "flex", flexDirection: "column", alignItems: "center",
                cursor: "pointer", gap: 8, padding: "0 4px",
              }}
            >
              <div style={{
                width: 48, height: 48, borderRadius: "50%",
                border: `2px solid ${active === i ? s.color : "#1E293B"}`,
                background: active === i ? `${s.color}18` : "#0D1520",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 20, color: active === i ? s.color : "#334155",
                transition: "all 0.3s ease",
                boxShadow: active === i ? `0 0 20px ${s.color}30` : "none",
              }}>
                {s.icon}
              </div>
              <div style={{
                fontSize: 10, fontFamily: "'JetBrains Mono', monospace",
                color: active === i ? s.color : "#475569",
                textTransform: "uppercase", letterSpacing: "0.1em",
                transition: "color 0.3s",
                textAlign: "center", maxWidth: 64,
              }}>{s.phase}</div>
            </div>

            {/* Connector line */}
            {i < stages.length - 1 && (
              <div style={{
                width: 40, height: 1,
                background: i < active
                  ? `linear-gradient(90deg, ${stages[i].color}, ${stages[i+1].color})`
                  : "#1E293B",
                transition: "background 0.4s",
                marginBottom: 22,
                flexShrink: 0,
              }} />
            )}
          </div>
        ))}
      </div>

      {/* Main detail card */}
      <div style={{
        maxWidth: 720, margin: "0 auto",
        background: "#0D1520",
        border: `1px solid ${stage.color}30`,
        borderRadius: 16,
        overflow: "hidden",
        transition: "border-color 0.4s",
        boxShadow: `0 0 40px ${stage.color}08`,
      }}>
        {/* Card header */}
        <div style={{
          padding: "24px 28px 20px",
          borderBottom: `1px solid ${stage.color}20`,
          background: `linear-gradient(135deg, ${stage.color}0A, transparent)`,
        }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
            <div>
              <div style={{
                fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                color: stage.color, letterSpacing: "0.15em", textTransform: "uppercase",
                marginBottom: 6,
              }}>Phase {stage.id} of {stages.length}</div>
              <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.02em", color: "#F1F5F9" }}>
                {stage.label}
              </div>
              <div style={{
                fontSize: 13, color: "#64748B", marginTop: 4,
                fontFamily: "'JetBrains Mono', monospace",
              }}>{stage.who}</div>
            </div>
            <div style={{
              fontSize: 40, color: stage.color, opacity: 0.4,
              transition: "color 0.4s",
            }}>{stage.icon}</div>
          </div>
          <div style={{
            fontSize: 14, color: "#94A3B8", marginTop: 14, lineHeight: 1.65,
          }}>{stage.description}</div>
        </div>

        {/* Documents */}
        <div style={{ padding: "20px 28px", borderBottom: `1px solid #0F1923` }}>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
            color: "#475569", textTransform: "uppercase", letterSpacing: "0.15em",
            marginBottom: 12,
          }}>Documents at this stage</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {stage.docs.map((doc, i) => (
              <div key={i} style={{
                background: `${stage.color}10`,
                border: `1px solid ${stage.color}25`,
                borderRadius: 6, padding: "5px 12px",
                fontSize: 12, color: stage.color,
                fontFamily: "'JetBrains Mono', monospace",
                transition: "all 0.3s",
              }}>{doc}</div>
            ))}
          </div>
        </div>

        {/* AI layer */}
        <div style={{ padding: "20px 28px", borderBottom: `1px solid #0F1923` }}>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
            <div style={{
              background: `${stage.color}15`,
              border: `1px solid ${stage.color}30`,
              borderRadius: 8, padding: "10px 14px", flex: 1,
            }}>
              <div style={{
                fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
                color: stage.color, textTransform: "uppercase", letterSpacing: "0.15em",
                marginBottom: 6,
              }}>✦ Claude AI at this stage</div>
              <div style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.6 }}>{stage.ai}</div>
            </div>
          </div>
        </div>

        {/* Output */}
        <div style={{ padding: "16px 28px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
              color: "#475569", textTransform: "uppercase", letterSpacing: "0.15em",
              whiteSpace: "nowrap",
            }}>Output →</div>
            <div style={{
              fontSize: 13, color: "#E2E8F0", fontWeight: 600,
            }}>{stage.output}</div>
          </div>
        </div>
      </div>

      {/* Connector descriptions */}
      {active < stages.length - 1 && (
        <div style={{
          maxWidth: 720, margin: "16px auto 0",
          textAlign: "center",
        }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            background: "#0D1520", border: "1px solid #1E293B",
            borderRadius: 999, padding: "6px 16px",
          }}>
            <span style={{ color: stage.color, fontSize: 12 }}>↓</span>
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#475569",
            }}>{connectors[active]}</span>
          </div>
        </div>
      )}

      {/* Nav buttons */}
      <div style={{
        display: "flex", justifyContent: "center", gap: 12, marginTop: 28,
      }}>
        <button onClick={() => setActive(Math.max(0, active - 1))} disabled={active === 0}
          style={{
            background: "transparent", border: "1px solid #1E293B",
            borderRadius: 8, padding: "8px 20px", color: active === 0 ? "#1E293B" : "#64748B",
            cursor: active === 0 ? "not-allowed" : "pointer",
            fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
            transition: "all 0.2s",
          }}>← prev</button>

        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {stages.map((s, i) => (
            <div key={i} onClick={() => setActive(i)} style={{
              width: active === i ? 20 : 6, height: 6,
              borderRadius: 3,
              background: active === i ? stage.color : "#1E293B",
              cursor: "pointer", transition: "all 0.3s",
            }} />
          ))}
        </div>

        <button onClick={() => setActive(Math.min(stages.length - 1, active + 1))} disabled={active === stages.length - 1}
          style={{
            background: active === stages.length - 1 ? "transparent" : `${stage.color}15`,
            border: `1px solid ${active === stages.length - 1 ? "#1E293B" : stage.color + "40"}`,
            borderRadius: 8, padding: "8px 20px",
            color: active === stages.length - 1 ? "#1E293B" : stage.color,
            cursor: active === stages.length - 1 ? "not-allowed" : "pointer",
            fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
            transition: "all 0.3s",
          }}>next →</button>
      </div>

      {/* Footer note */}
      <div style={{
        textAlign: "center", marginTop: 32,
        fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#1E293B",
      }}>
        Every stage versioned · Every change traceable · Full rollback at any point
      </div>
    </div>
  );
}
