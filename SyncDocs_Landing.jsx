import { useState, useEffect, useRef } from "react";

const STAGES = [
  { icon: "◎", label: "Idea", color: "#E8C547" },
  { icon: "◈", label: "PRD", color: "#4EC9B0" },
  { icon: "◫", label: "Architecture", color: "#7B9FE0" },
  { icon: "◧", label: "Dev Spec", color: "#C084FC" },
  { icon: "◉", label: "Living Code", color: "#F87171" },
];

const FEATURES = [
  {
    icon: "⟳",
    title: "Always In Sync",
    desc: "SyncDocs watches your codebase for drift. The moment your implementation diverges from your spec, you know — before it becomes a problem.",
    color: "#4EC9B0",
  },
  {
    icon: "✦",
    title: "AI at Every Stage",
    desc: "Claude assists from concept to code. Stress-test ideas, score PRD completeness, generate AI-ready specs, and detect intent violations in real time.",
    color: "#E8C547",
  },
  {
    icon: "◈",
    title: "Non-Dev to Ticket",
    desc: "Stakeholders edit documentation. SyncDocs converts those changes into tickets automatically — no translation tax, no lost intent.",
    color: "#C084FC",
  },
  {
    icon: "⊕",
    title: "Full Version History",
    desc: "Git for your entire product — docs, decisions, tickets, and code. Roll back to any state. Understand why anything is the way it is.",
    color: "#7B9FE0",
  },
  {
    icon: "⬡",
    title: "AI Agent Map",
    desc: "Visualize the relationships between every artifact in your product. See how a stakeholder request traces through to a line of code.",
    color: "#F87171",
  },
  {
    icon: "◧",
    title: "AI-Ready Specs",
    desc: "Write specs that actually produce great AI-generated code. SyncDocs scores and improves your specs before they reach an AI coding agent.",
    color: "#4EC9B0",
  },
];

function useInView(ref) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) setInView(true); }, { threshold: 0.15 });
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);
  return inView;
}

function FadeIn({ children, delay = 0, style = {} }) {
  const ref = useRef();
  const inView = useInView(ref);
  return (
    <div ref={ref} style={{
      opacity: inView ? 1 : 0,
      transform: inView ? "translateY(0)" : "translateY(24px)",
      transition: `opacity 0.7s ease ${delay}s, transform 0.7s ease ${delay}s`,
      ...style,
    }}>{children}</div>
  );
}

export default function SyncDocsLanding() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [activeStage, setActiveStage] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap";
    document.head.appendChild(link);
  }, []);

  // Auto-advance stages
  useEffect(() => {
    const t = setInterval(() => {
      setActiveStage(s => (s + 1) % STAGES.length);
      setTick(t => t + 1);
    }, 1800);
    return () => clearInterval(t);
  }, []);

  const stage = STAGES[activeStage];

  return (
    <div style={{
      background: "#07090D",
      color: "#E2E8F0",
      fontFamily: "'Syne', sans-serif",
      overflowX: "hidden",
    }}>

      {/* ── NAV ── */}
      <nav style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "18px 40px", borderBottom: "1px solid #0F1923",
        position: "sticky", top: 0, zIndex: 100,
        background: "#07090Dee", backdropFilter: "blur(12px)",
      }}>
        <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em" }}>
          Sync<span style={{ color: stage.color, transition: "color 0.5s" }}>Docs</span>
        </div>
        <div style={{ display: "flex", gap: 28, alignItems: "center" }}>
          {["Product", "Pricing", "Docs"].map(l => (
            <span key={l} style={{ fontSize: 13, color: "#475569", cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>{l}</span>
          ))}
          <div style={{
            background: stage.color, color: "#07090D",
            padding: "7px 18px", borderRadius: 8,
            fontSize: 13, fontWeight: 700, cursor: "pointer",
            transition: "background 0.5s",
          }}>Join Waitlist</div>
        </div>
      </nav>

      {/* ── HERO ── */}
      <section style={{
        minHeight: "92vh", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        padding: "80px 28px 60px", textAlign: "center", position: "relative",
      }}>
        {/* Radial glow */}
        <div style={{
          position: "absolute", top: "40%", left: "50%", transform: "translate(-50%, -50%)",
          width: 800, height: 800, borderRadius: "50%",
          background: `radial-gradient(circle, ${stage.color}0C 0%, transparent 65%)`,
          pointerEvents: "none", transition: "background 0.6s",
        }} />

        {/* Badge */}
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          background: "#0D1520", border: `1px solid ${stage.color}30`,
          borderRadius: 999, padding: "5px 16px", marginBottom: 32,
          transition: "border-color 0.5s",
        }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: stage.color, transition: "background 0.5s" }} />
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.15em" }}>
            Now in private beta
          </span>
        </div>

        {/* Headline */}
        <h1 style={{
          fontSize: "clamp(42px, 7vw, 80px)", fontWeight: 800,
          lineHeight: 1.05, letterSpacing: "-0.03em",
          margin: "0 0 20px", maxWidth: 860,
        }}>
          From first idea<br />
          to{" "}
          <span style={{
            color: stage.color,
            transition: "color 0.5s",
            position: "relative",
          }}>
            living codebase
            <span style={{
              position: "absolute", bottom: -4, left: 0, right: 0, height: 3,
              background: stage.color, borderRadius: 2, opacity: 0.4,
              transition: "background 0.5s",
            }} />
          </span>
          .
        </h1>

        <p style={{
          fontSize: 18, color: "#64748B", maxWidth: 560,
          lineHeight: 1.7, margin: "0 0 48px",
          fontFamily: "'JetBrains Mono', monospace", fontWeight: 400,
        }}>
          SyncDocs unifies your product lifecycle — concept, PRD, architecture, specs, and code — in one platform that keeps everything in sync, forever.
        </p>

        {/* CTA */}
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
          {!submitted ? (
            <>
              <input
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="your@email.com"
                style={{
                  background: "#0D1520", border: `1px solid #1E293B`,
                  borderRadius: 10, padding: "13px 20px", color: "#E2E8F0",
                  fontSize: 15, outline: "none", width: 260,
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              />
              <div
                onClick={() => email && setSubmitted(true)}
                style={{
                  background: stage.color, color: "#07090D",
                  padding: "13px 28px", borderRadius: 10,
                  fontSize: 15, fontWeight: 700, cursor: "pointer",
                  transition: "background 0.5s, transform 0.15s",
                }}>
                Get Early Access
              </div>
            </>
          ) : (
            <div style={{
              background: "#0D1520", border: `1px solid ${stage.color}40`,
              borderRadius: 10, padding: "13px 28px",
              fontFamily: "'JetBrains Mono', monospace", fontSize: 14, color: stage.color,
            }}>✓ You're on the list. We'll be in touch.</div>
          )}
        </div>

        {/* Stage progress strip */}
        <div style={{ display: "flex", gap: 6, marginTop: 56, alignItems: "center" }}>
          {STAGES.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 6,
                opacity: activeStage === i ? 1 : 0.3,
                transition: "opacity 0.4s",
              }}>
                <span style={{ color: s.color, fontSize: 14 }}>{s.icon}</span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: s.color }}>{s.label}</span>
              </div>
              {i < STAGES.length - 1 && (
                <span style={{ color: "#1E293B", fontSize: 12, marginLeft: 2 }}>→</span>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── THE PROBLEM ── */}
      <section style={{ padding: "80px 40px", maxWidth: 900, margin: "0 auto" }}>
        <FadeIn>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
            color: "#475569", textTransform: "uppercase", letterSpacing: "0.15em",
            marginBottom: 16, textAlign: "center",
          }}>The Problem</div>
          <h2 style={{
            fontSize: "clamp(28px, 4vw, 44px)", fontWeight: 800,
            letterSpacing: "-0.025em", textAlign: "center",
            lineHeight: 1.15, marginBottom: 40,
          }}>
            Your spec and your code<br />
            <span style={{ color: "#F85149" }}>are already out of sync.</span>
          </h2>
        </FadeIn>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
          {[
            { stat: "62%", label: "of developers say technical debt is their #1 frustration at work", source: "Stack Overflow Developer Survey, 2024" },
            { stat: "41%", label: "cite insufficient documentation as a key source of wasted time each week", source: "Atlassian State of Developer Experience, 2024" },
            { stat: "8h+", label: "per week lost by 69% of developers to workflow inefficiencies — every week", source: "Atlassian State of Developer Experience, 2024" },
          ].map((item, i) => (
            <FadeIn key={i} delay={i * 0.1}>
              <div style={{
                background: "#0D1520", border: "1px solid #1E293B",
                borderRadius: 12, padding: "28px 24px", textAlign: "center",
              }}>
                <div style={{ fontSize: 44, fontWeight: 800, color: "#F85149", letterSpacing: "-0.03em", lineHeight: 1 }}>{item.stat}</div>
                <div style={{ fontSize: 13, color: "#64748B", marginTop: 10, lineHeight: 1.6, fontFamily: "'JetBrains Mono', monospace" }}>{item.label}</div>
                <div style={{ fontSize: 10, color: "#1E293B", marginTop: 8, fontFamily: "'JetBrains Mono', monospace" }}>{item.source}</div>
              </div>
            </FadeIn>
          ))}
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section style={{ padding: "80px 40px", maxWidth: 1000, margin: "0 auto" }}>
        <FadeIn>
          <div style={{ textAlign: "center", marginBottom: 52 }}>
            <div style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
              color: "#475569", textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: 14,
            }}>What SyncDocs Does</div>
            <h2 style={{ fontSize: "clamp(26px, 3.5vw, 40px)", fontWeight: 800, letterSpacing: "-0.025em", lineHeight: 1.15 }}>
              One platform. The entire journey.
            </h2>
          </div>
        </FadeIn>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
          {FEATURES.map((f, i) => (
            <FadeIn key={i} delay={i * 0.08}>
              <div style={{
                background: "#0D1520",
                border: `1px solid ${f.color}20`,
                borderTop: `3px solid ${f.color}`,
                borderRadius: 12, padding: "24px 22px",
                transition: "transform 0.2s",
              }}
                onMouseEnter={e => e.currentTarget.style.transform = "translateY(-4px)"}
                onMouseLeave={e => e.currentTarget.style.transform = "translateY(0)"}
              >
                <div style={{ fontSize: 24, color: f.color, marginBottom: 12 }}>{f.icon}</div>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, letterSpacing: "-0.01em" }}>{f.title}</div>
                <div style={{ fontSize: 13, color: "#64748B", lineHeight: 1.65, fontFamily: "'JetBrains Mono', monospace" }}>{f.desc}</div>
              </div>
            </FadeIn>
          ))}
        </div>
      </section>

      {/* ── THE REAL PROBLEM ── */}
      <section style={{ padding: "80px 40px", maxWidth: 860, margin: "0 auto" }}>
        <FadeIn>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
            color: "#475569", textTransform: "uppercase", letterSpacing: "0.15em",
            marginBottom: 36, textAlign: "center",
          }}>Sound familiar?</div>
        </FadeIn>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {[
            { pain: "You write a spec. The AI generates code from it. Two weeks later the spec and the code tell two different stories — and nobody knows which one is right.", color: STAGES[0].color },
            { pain: "A stakeholder asks why a feature works a certain way. The original PRD is buried in a Notion page nobody can find, and the engineer who built it left six months ago.", color: STAGES[2].color },
            { pain: "A PM wants to change a requirement. It takes three meetings, two Jira tickets, a Slack thread, and a week of back-and-forth before a developer writes a single line of code.", color: STAGES[3].color },
          ].map((item, i) => (
            <FadeIn key={i} delay={i * 0.1}>
              <div style={{
                background: "#0D1520", border: "1px solid #1E293B",
                borderLeft: `3px solid ${item.color}`,
                borderRadius: 12, padding: "22px 24px",
                display: "flex", gap: 20, alignItems: "flex-start",
              }}>
                <div style={{ fontSize: 28, color: item.color, lineHeight: 1, flexShrink: 0, opacity: 0.6 }}>"</div>
                <div style={{ fontSize: 14, color: "#94A3B8", lineHeight: 1.7 }}>{item.pain}</div>
              </div>
            </FadeIn>
          ))}
        </div>
        <FadeIn delay={0.3}>
          <div style={{
            textAlign: "center", marginTop: 32,
            fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: "#475569",
          }}>
            SyncDocs is being built to solve exactly this. We're in private beta —{" "}
            <span style={{ color: STAGES[1].color }}>join the waitlist to shape the product.</span>
          </div>
        </FadeIn>
      </section>

      {/* ── PRICING ── */}
      <section style={{ padding: "80px 40px", maxWidth: 860, margin: "0 auto" }}>
        <FadeIn>
          <div style={{ textAlign: "center", marginBottom: 48 }}>
            <div style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
              color: "#475569", textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: 14,
            }}>Pricing</div>
            <h2 style={{ fontSize: "clamp(24px, 3vw, 36px)", fontWeight: 800, letterSpacing: "-0.025em" }}>Simple. Transparent. Worth it.</h2>
          </div>
        </FadeIn>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
          {[
            { name: "Free", price: "$0", desc: "1 project · 1 user · Limited history", color: "#475569", cta: "Start free" },
            { name: "Starter", price: "$29/mo", desc: "5 users · 5 projects · Full history", color: "#58A6FF", cta: "Get started", popular: false },
            { name: "Team", price: "$99/mo", desc: "20 users · Unlimited projects · Non-dev seats", color: "#4EC9B0", cta: "Best for teams", popular: true },
            { name: "Enterprise", price: "Custom", desc: "SSO · SLA · Dedicated support", color: "#C084FC", cta: "Contact us" },
          ].map((p, i) => (
            <FadeIn key={i} delay={i * 0.08}>
              <div style={{
                background: p.popular ? `${p.color}0F` : "#0D1520",
                border: `1px solid ${p.popular ? p.color + "50" : "#1E293B"}`,
                borderRadius: 14, padding: "26px 22px",
                position: "relative",
              }}>
                {p.popular && (
                  <div style={{
                    position: "absolute", top: -12, left: "50%", transform: "translateX(-50%)",
                    background: p.color, color: "#07090D",
                    fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
                    padding: "3px 12px", borderRadius: 999, fontWeight: 700,
                    textTransform: "uppercase", letterSpacing: "0.1em",
                  }}>Most Popular</div>
                )}
                <div style={{ fontSize: 13, fontWeight: 700, color: p.color, marginBottom: 8, fontFamily: "'JetBrains Mono', monospace" }}>{p.name}</div>
                <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.02em", marginBottom: 10 }}>{p.price}</div>
                <div style={{ fontSize: 12, color: "#475569", marginBottom: 20, lineHeight: 1.6, fontFamily: "'JetBrains Mono', monospace" }}>{p.desc}</div>
                <div style={{
                  background: p.popular ? p.color : "transparent",
                  border: `1px solid ${p.color}50`,
                  borderRadius: 8, padding: "9px 0", textAlign: "center",
                  fontSize: 13, fontWeight: 700, cursor: "pointer",
                  color: p.popular ? "#07090D" : p.color,
                }}>{p.cta}</div>
              </div>
            </FadeIn>
          ))}
        </div>
      </section>

      {/* ── REFERENCES ── */}
      <section style={{ padding: "60px 40px", maxWidth: 860, margin: "0 auto" }}>
        <FadeIn>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
            color: "#475569", textTransform: "uppercase", letterSpacing: "0.15em",
            marginBottom: 20,
          }}>Research References</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[
              {
                stat: "62%",
                claim: "of developers say technical debt is their #1 frustration at work",
                source: "Stack Overflow Developer Survey 2024",
                url: "https://survey.stackoverflow.co/2024/",
                color: "#F87171",
              },
              {
                stat: "41%",
                claim: "cite insufficient documentation as a key source of weekly wasted time",
                source: "Atlassian State of Developer Experience, 2024",
                url: "https://shiftmag.dev/developers-waste-8-hours-weekly-on-inefficiencies-like-technical-debt-3956/",
                color: "#4EC9B0",
              },
              {
                stat: "8h+",
                claim: "per week lost by 69% of developers to workflow inefficiencies",
                source: "Atlassian State of Developer Experience, 2024",
                url: "https://shiftmag.dev/developers-waste-8-hours-weekly-on-inefficiencies-like-technical-debt-3956/",
                color: "#E8C547",
              },
              {
                stat: "81%",
                claim: "of developers expect AI tools will change how they document code within a year",
                source: "Stack Overflow Developer Survey 2024",
                url: "https://survey.stackoverflow.co/2024/",
                color: "#C084FC",
              },
              {
                stat: "42%",
                claim: "of code written today is AI-generated or significantly AI-assisted",
                source: "Sonar State of Code Developer Survey, 2025",
                url: "https://www.sonarsource.com/state-of-code-developer-survey-report.pdf",
                color: "#7B9FE0",
              },
            ].map((ref, i) => (
              <a
                key={i}
                href={ref.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ textDecoration: "none" }}
              >
                <div style={{
                  background: "#0D1520",
                  border: "1px solid #1E293B",
                  borderLeft: `3px solid ${ref.color}`,
                  borderRadius: 8,
                  padding: "12px 16px",
                  display: "flex", alignItems: "center", gap: 14,
                  transition: "border-color 0.2s",
                }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = ref.color + "50"}
                  onMouseLeave={e => e.currentTarget.style.borderColor = "#1E293B"}
                >
                  <div style={{
                    fontFamily: "'Syne', sans-serif", fontSize: 16, fontWeight: 800,
                    color: ref.color, minWidth: 44, flexShrink: 0,
                  }}>{ref.stat}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, color: "#94A3B8", lineHeight: 1.5 }}>{ref.claim}</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#334155", marginTop: 3 }}>
                      {ref.source} ↗
                    </div>
                  </div>
                </div>
              </a>
            ))}
          </div>
        </FadeIn>
      </section>

      {/* ── FINAL CTA ── */}
      <section style={{
        padding: "100px 28px", textAlign: "center",
        borderTop: "1px solid #0F1923",
        position: "relative", overflow: "hidden",
      }}>
        <div style={{
          position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
          width: 700, height: 400, borderRadius: "50%",
          background: `radial-gradient(circle, ${stage.color}0A 0%, transparent 70%)`,
          pointerEvents: "none", transition: "background 0.6s",
        }} />
        <FadeIn>
          <div style={{ fontSize: "clamp(32px, 5vw, 60px)", fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.1, marginBottom: 20 }}>
            From first idea<br />
            to <span style={{ color: stage.color, transition: "color 0.5s" }}>living codebase.</span>
          </div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, color: "#475569", marginBottom: 36 }}>
            Join the waitlist. Be among the first to build differently.
          </div>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <input
              placeholder="your@email.com"
              style={{
                background: "#0D1520", border: "1px solid #1E293B",
                borderRadius: 10, padding: "13px 20px", color: "#E2E8F0",
                fontSize: 15, outline: "none", width: 260,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            />
            <div style={{
              background: stage.color, color: "#07090D",
              padding: "13px 28px", borderRadius: 10,
              fontSize: 15, fontWeight: 700, cursor: "pointer",
              transition: "background 0.5s",
            }}>Get Early Access</div>
          </div>
        </FadeIn>
      </section>

      {/* ── FOOTER ── */}
      <footer style={{
        padding: "28px 40px", borderTop: "1px solid #0F1923",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        flexWrap: "wrap", gap: 12,
      }}>
        <div style={{ fontSize: 16, fontWeight: 800 }}>
          Sync<span style={{ color: stage.color, transition: "color 0.5s" }}>Docs</span>
        </div>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#1E293B" }}>
          © 2026 SyncDocs · Built by Alejandro Londono
        </div>
      </footer>
    </div>
  );
}
