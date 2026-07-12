import { useState, useEffect, useRef, useCallback } from "react";

// ─── AU AIP ENR 1.5 / ICAO PANS-OPS Speed Table ─────────────────────────────
const ICAO_CATS = {
  A: { label: "Cat A", vatRange: "≤90kt", maxBelow14k: 170, maxAbove14k: 170 },
  B: { label: "Cat B", vatRange: "91–120kt", maxBelow14k: 170, maxAbove14k: 220 },
  C: { label: "Cat C", vatRange: "121–140kt", maxBelow14k: 230, maxAbove14k: 240 },
  D: { label: "Cat D", vatRange: "141–165kt", maxBelow14k: 230, maxAbove14k: 240 },
  E: { label: "Cat E", vatRange: "166–210kt", maxBelow14k: 230, maxAbove14k: 240 },
};

// ─── Core maths ──────────────────────────────────────────────────────────────
const norm = (a) => ((a % 360) + 360) % 360;

function getSectorEntry(acHdg, inboundTrack, turnDir) {
  // Correct ICAO / AU AIP ENR 1.5 sector algorithm:
  // Sectors defined by bearing FROM fix (= acHdg + 180), relative to outbound direction.
  // For right hold:  S3=[outbound,+110°], S1=[+110°,+290°], S2=[+290°,+360°]
  // For left hold:   S3=[outbound-110°,outbound], S1=[outbound-290°,outbound-110°], S2=[outbound-290°,outbound] reversed
  const outbound = norm(inboundTrack + 180);
  const bearingFromFix = norm(acHdg + 180);
  const sign = turnDir === "R" ? 1 : -1;
  const rel = norm((bearingFromFix - outbound) * sign);

  const offsetHeading =
    turnDir === "R"
      ? norm(outbound - 30)   // 30° CCW (holding/left side for right hold)
      : norm(outbound + 30);  // 30° CW (holding/right side for left hold)

  if (rel <= 110) {
    return {
      sector: 3,
      name: "Sector 3 — Direct Entry",
      color: "#4CAF82",
      bgColor: "#0D2D1C",
      borderColor: "#4CAF82",
      procedure: [
        `Cross the fix and turn immediately ${turnDir === "R" ? "RIGHT" : "LEFT"} (holding side).`,
        `Fly outbound on ${norm(inboundTrack + 180)}°M for the published time/DME.`,
        `Turn ${turnDir === "R" ? "RIGHT" : "LEFT"} onto the inbound track ${norm(inboundTrack)}°M.`,
        `Establish inbound and cross the fix to commence the hold.`,
      ],
      badge: "S3 · DIRECT",
    };
  }
  if (rel <= 290) {
    return {
      sector: 1,
      name: "Sector 1 — Parallel Entry",
      color: "#5B9FD8",
      bgColor: "#1B2D45",
      borderColor: "#5B9FD8",
      procedure: [
        `Cross the fix and turn to fly PARALLEL to the inbound (${norm(inboundTrack)}°M) on the NON-HOLDING side.`,
        `Fly outbound parallel for the published time/distance.`,
        `Turn ${turnDir === "R" ? "LEFT" : "RIGHT"} (into holding side) through MORE than 180° to intercept inbound.`,
        `Track inbound ${norm(inboundTrack)}°M to the fix.`,
      ],
      badge: "S1 · PARALLEL",
    };
  }
  return {
    sector: 2,
    name: "Sector 2 — Offset Entry",
    color: "#F5A623",
    bgColor: "#3A2800",
    borderColor: "#F5A623",
    procedure: [
      `Cross the fix and turn to fly offset heading ${offsetHeading}°M (30° from outbound toward holding side).`,
      `Fly offset for up to the published time (max 1.5 min even if chart shows 1 min — AIP ENR 1.5).`,
      `Turn ${turnDir === "R" ? "RIGHT" : "LEFT"} to intercept inbound track ${norm(inboundTrack)}°M.`,
      `Establish inbound and cross fix.`,
    ],
    offsetHeading,
    badge: "S2 · OFFSET",
  };
}

function getMaxSpeed(cat, altFt) {
  const fl = altFt / 100;
  return fl <= 140 ? ICAO_CATS[cat].maxBelow14k : ICAO_CATS[cat].maxAbove14k;
}

function getLegTimeSecs(altFt, chartedMin) {
  if (chartedMin) return Math.round(parseFloat(chartedMin) * 60);
  return altFt / 100 <= 140 ? 60 : 90;
}

function fmtTime(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function calcWind(inbTrack, windDir, windSpd, tas) {
  const inbRad = (inbTrack * Math.PI) / 180;
  const wRad = (windDir * Math.PI) / 180;
  const hw = windSpd * Math.cos(wRad - inbRad);
  const xw = windSpd * Math.sin(wRad - inbRad);
  const wcaDeg = Math.round(Math.atan2(xw, tas) * (180 / Math.PI));
  // hw positive = wind component in same direction as inbound track = tailwind → increases GS
  const gsInbound = Math.round(Math.sqrt(Math.max(0, tas * tas - xw * xw)) + hw);
  return { hw: Math.round(hw), xw: Math.round(xw), wca: wcaDeg, gsInbound };
}

function calcOutboundTime(inbTrack, windDir, windSpd, tas, stdLegSecs) {
  const outbTrack = norm(inbTrack + 180);
  const outbRad = (outbTrack * Math.PI) / 180;
  const wRad = (windDir * Math.PI) / 180;
  const hwOut = windSpd * Math.cos(wRad - outbRad);
  const xw = windSpd * Math.sin(wRad - outbRad);
  // hwOut positive = tailwind on outbound. gsOut benefits; gsIn is opposite (headwind on inbound).
  const spd = Math.sqrt(Math.max(1, tas * tas - xw * xw));
  const gsOut = spd + hwOut;  // TW on outbound adds to GS
  const gsIn  = spd - hwOut;  // TW on outbound = HW on inbound, reduces inbound GS
  if (gsIn <= 0) return { secs: stdLegSecs, note: "GS too low" };
  const distNM = (stdLegSecs / 3600) * gsIn;
  const outSecs = Math.round((distNM / gsOut) * 3600);
  return { secs: outSecs, distNM: distNM.toFixed(2), gsIn: Math.round(gsIn), gsOut: Math.round(gsOut) };
}

// ─── Colour system ────────────────────────────────────────────────────────────
const C = {
  bg:           "#0B0D12",
  surface:      "#131620",
  surfaceRaise: "#181C28",
  surfaceHigh:  "#1E2335",
  border:       "#242840",
  borderLight:  "#2E3450",
  accent:       "#E8A020",   // amber — primary action
  accentDim:    "#6B4A10",
  accentGlow:   "#E8A02022",
  blue:         "#4D8FC9",
  blueDim:      "#1A3050",
  green:        "#3DAF76",
  greenDim:     "#122B1E",
  red:          "#D94F4F",
  redDim:       "#2D1010",
  text:         "#DCE0EC",
  textSub:      "#6E7590",
  textMuted:    "#3E4460",
  s1:           "#4D8FC9",
  s2:           "#E8A020",
  s3:           "#3DAF76",
};

// ─── SVG Holding Pattern Diagram ─────────────────────────────────────────────
function HoldDiagram({ inboundTrack, turnDir, sector, acHdg }) {
  const cx = 110, cy = 110, R = 110;

  const toXY = (bearingDeg, r) => {
    const a = ((bearingDeg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };

  const outbound = norm(inboundTrack + 180);
  const sign = turnDir === "R" ? 1 : -1;

  // Sector boundary bearings FROM fix
  const b1 = norm(outbound + sign * 110);
  const b2 = norm(outbound + sign * 290);

  const arcPath = (startBearing, sweep, r, col, opacity = 0.15) => {
    const steps = Math.max(2, Math.round(sweep / 5));
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const br = norm(startBearing + (i / steps) * sweep * sign);
      const [x, y] = toXY(br, r);
      pts.push(`${x},${y}`);
    }
    return (
      <polygon
        points={`${cx},${cy} ${pts.join(" ")}`}
        fill={col}
        fillOpacity={opacity}
        stroke={col}
        strokeOpacity={opacity * 1.5}
        strokeWidth={0.5}
      />
    );
  };

  // Draw racetrack
  const ovalSemiMajor = 45;
  const ovalSemiMinor = 22;
  const ovalAngleDeg = inboundTrack - 90;

  // fix point (bottom of racetrack)
  const [fixX, fixY] = toXY(inboundTrack, 32);

  // Heading arrow
  let acX1, acY1, acX2, acY2;
  if (acHdg !== null) {
    [acX1, acY1] = toXY(norm(acHdg + 180), R * 0.5);
    [acX2, acY2] = toXY(acHdg, R * 0.85);
  }

  return (
    <svg viewBox="0 0 220 220" style={{ width: "100%", maxWidth: 220, display: "block", margin: "0 auto" }}>
      <defs>
        <marker id="arrowAmber" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
          <path d="M0,0 L7,3.5 L0,7 Z" fill={C.accent} />
        </marker>
        <marker id="arrowRed" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
          <path d="M0,0 L7,3.5 L0,7 Z" fill="#FF6060" />
        </marker>
        <filter id="glow">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>

      {/* Outer ring */}
      <circle cx={cx} cy={cy} r={R - 2} fill={C.surface} />
      <circle cx={cx} cy={cy} r={R - 2} fill="none" stroke={C.border} strokeWidth={1} />

      {/* Compass ticks */}
      {Array.from({ length: 36 }, (_, i) => {
        const br = i * 10;
        const isMajor = br % 30 === 0;
        const [x1, y1] = toXY(br, R - 8);
        const [x2, y2] = toXY(br, R - (isMajor ? 18 : 13));
        const labels = { 0: "N", 90: "E", 180: "S", 270: "W" };
        const [lx, ly] = toXY(br, R - 24);
        return (
          <g key={br}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={isMajor ? C.textSub : C.textMuted} strokeWidth={isMajor ? 1.2 : 0.6} />
            {labels[br] && (
              <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle"
                fontSize="8" fill={C.textSub} fontFamily="monospace" fontWeight="bold">{labels[br]}</text>
            )}
          </g>
        );
      })}

      {/* Sector wedges */}
      {arcPath(outbound, 110, R - 30, C.s3)}
      {arcPath(norm(outbound + sign * 110), 180, R - 30, C.s1)}
      {arcPath(norm(outbound + sign * 290), 70, R - 30, C.s2)}

      {/* Active sector highlight */}
      {sector === 3 && arcPath(outbound, 110, R - 30, C.s3, 0.35)}
      {sector === 1 && arcPath(norm(outbound + sign * 110), 180, R - 30, C.s1, 0.35)}
      {sector === 2 && arcPath(norm(outbound + sign * 290), 70, R - 30, C.s2, 0.35)}

      {/* Boundary lines */}
      {[norm(outbound + sign * 110), norm(outbound + sign * 290)].map((br, i) => {
        const [lx, ly] = toXY(br, R - 30);
        return <line key={i} x1={cx} y1={cy} x2={lx} y2={ly} stroke={C.borderLight} strokeWidth={1} strokeDasharray="3 2" />;
      })}

      {/* Outbound direction line */}
      {(() => {
        const [ox, oy] = toXY(outbound, R - 30);
        return <line x1={cx} y1={cy} x2={ox} y2={oy} stroke={C.accent} strokeWidth={1} strokeDasharray="4 3" opacity={0.5} />;
      })()}

      {/* Racetrack oval */}
      <g transform={`rotate(${ovalAngleDeg} ${cx} ${cy})`}>
        <ellipse
          cx={cx} cy={cy}
          rx={ovalSemiMinor} ry={ovalSemiMajor}
          fill="none"
          stroke={C.accent}
          strokeWidth={1.8}
          strokeOpacity={0.8}
          filter="url(#glow)"
        />
      </g>

      {/* Fix dot */}
      {(() => {
        const [fx, fy] = toXY(inboundTrack, ovalSemiMajor - ovalSemiMinor + 2);
        // approximate fix at bottom of racetrack
        return (
          <g>
            <circle cx={cx} cy={cx} r={3.5} fill={C.accent} opacity={0.9} />
            <text x={cx} y={cx - 8} textAnchor="middle" fontSize="6.5" fill={C.accent} fontFamily="monospace">FIX</text>
          </g>
        );
      })()}

      {/* Inbound arrow */}
      {(() => {
        const [ax, ay] = toXY(norm(inboundTrack + 180), R * 0.55);
        return (
          <line x1={ax} y1={ay} x2={cx} y2={cx}
            stroke={C.accent} strokeWidth={2} markerEnd="url(#arrowAmber)" opacity={0.9} />
        );
      })()}

      {/* Aircraft heading arrow */}
      {acHdg !== null && (() => {
        const [ax, ay] = toXY(norm(acHdg + 180), R * 0.48);
        const [bx, by] = toXY(acHdg, R * 0.8);
        return (
          <line x1={ax} y1={ay} x2={bx} y2={by}
            stroke="#FF6060" strokeWidth={2.2} markerEnd="url(#arrowRed)"
            strokeDasharray="5 2" opacity={0.9} />
        );
      })()}

      {/* Sector labels */}
      {[
        { br: norm(outbound + sign * 55), label: "S3", col: C.s3 },
        { br: norm(outbound + sign * 200), label: "S1", col: C.s1 },
        { br: norm(outbound + sign * 325), label: "S2", col: C.s2 },
      ].map(({ br, label, col }) => {
        const [lx, ly] = toXY(br, R * 0.6);
        return (
          <text key={label} x={lx} y={ly} textAnchor="middle" dominantBaseline="middle"
            fontSize="10" fontWeight="bold" fill={col} fontFamily="monospace" opacity={0.85}>
            {label}
          </text>
        );
      })}

      {/* Inbound track label */}
      {(() => {
        const [lx, ly] = toXY(norm(inboundTrack + 180), R * 0.42);
        return (
          <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle"
            fontSize="7" fill={C.accent} fontFamily="monospace">{norm(inboundTrack)}°M</text>
        );
      })()}

      {/* Legend */}
      <text x={4} y={212} fontSize="6.5" fill="#FF6060" fontFamily="monospace">▶ AC HDG</text>
      <text x={66} y={212} fontSize="6.5" fill={C.accent} fontFamily="monospace">▶ INBOUND</text>
    </svg>
  );
}

// ─── Shared UI primitives ─────────────────────────────────────────────────────
const Label = ({ children }) => (
  <div style={{ fontSize: 9, letterSpacing: 1.8, color: C.textSub, textTransform: "uppercase", marginBottom: 5, fontFamily: "monospace" }}>
    {children}
  </div>
);

const Input = ({ value, onChange, placeholder, type = "number", style = {} }) => (
  <input
    type={type}
    value={value}
    onChange={onChange}
    placeholder={placeholder}
    style={{
      background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6,
      color: C.text, padding: "10px 12px", fontSize: 15, fontFamily: "monospace",
      width: "100%", boxSizing: "border-box", outline: "none",
      WebkitAppearance: "none", ...style,
    }}
    onFocus={e => (e.target.style.borderColor = C.accent)}
    onBlur={e => (e.target.style.borderColor = C.border)}
  />
);

const Select = ({ value, onChange, children }) => (
  <select
    value={value}
    onChange={onChange}
    style={{
      background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6,
      color: C.text, padding: "10px 12px", fontSize: 13, fontFamily: "monospace",
      width: "100%", boxSizing: "border-box", outline: "none", WebkitAppearance: "none",
    }}
  >
    {children}
  </select>
);

const SegBtn = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    style={{
      flex: 1, padding: "10px 6px",
      background: active ? C.accentDim : C.bg,
      border: `1px solid ${active ? C.accent : C.border}`,
      borderRadius: 6, color: active ? C.accent : C.textSub,
      cursor: "pointer", fontSize: 11, fontFamily: "monospace",
      fontWeight: active ? 700 : 400, letterSpacing: 1,
    }}
  >
    {children}
  </button>
);

const Card = ({ children, style = {} }) => (
  <div style={{
    background: C.surface, border: `1px solid ${C.border}`,
    borderRadius: 10, padding: "14px 14px", marginBottom: 12, ...style
  }}>
    {children}
  </div>
);

const CardTitle = ({ icon, children }) => (
  <div style={{
    fontSize: 9, letterSpacing: 2.5, color: C.textSub, textTransform: "uppercase",
    marginBottom: 12, display: "flex", alignItems: "center", gap: 7, fontFamily: "monospace",
  }}>
    <span style={{ color: C.accent, fontSize: 11 }}>{icon}</span>
    {children}
  </div>
);

const DataRow = ({ label, value, valueColor = C.text, large = false }) => (
  <div style={{
    display: "flex", justifyContent: "space-between", alignItems: "baseline",
    padding: "7px 0", borderBottom: `1px solid ${C.border}`,
  }}>
    <span style={{ fontSize: 10, color: C.textSub, letterSpacing: 1.2, fontFamily: "monospace" }}>{label}</span>
    <span style={{ fontSize: large ? 18 : 14, fontWeight: 700, color: valueColor, fontFamily: "monospace" }}>{value}</span>
  </div>
);

const Pill = ({ color, children }) => (
  <span style={{
    display: "inline-block", padding: "2px 9px", borderRadius: 10,
    fontSize: 9, background: color + "22", color, border: `1px solid ${color}`,
    letterSpacing: 1.2, fontWeight: 700, fontFamily: "monospace",
  }}>{children}</span>
);

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function HoldMaster() {
  const [tab, setTab] = useState("calc");

  // ── Calculator state ──
  const [inboundTrack, setInboundTrack] = useState("");
  const [altitude, setAltitude]         = useState("");
  const [turnDir, setTurnDir]           = useState("R");
  const [cat, setCat]                   = useState("A");
  const [tas, setTas]                   = useState("");
  const [chartedMin, setChartedMin]     = useState("");
  const [acHdg, setAcHdg]               = useState("");
  const [windDir, setWindDir]           = useState("");
  const [windSpd, setWindSpd]           = useState("");
  const [saveKey, setSaveKey]           = useState("");
  const [saved, setSaved]               = useState(false);

  // ── Memory bank ──
  const [memories, setMemories] = useState(() => {
    try { return JSON.parse(localStorage.getItem("holdmaster_v2") || "{}"); }
    catch { return {}; }
  });
  const [memSearch, setMemSearch] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  useEffect(() => {
    try { localStorage.setItem("holdmaster_v2", JSON.stringify(memories)); }
    catch {}
  }, [memories]);

  // ── Parsed values ──
  const inb  = parseInt(inboundTrack, 10);
  const alt  = parseInt(altitude, 10);
  const tasN = parseInt(tas, 10);
  const hdg  = parseInt(acHdg, 10);
  const wd   = parseInt(windDir, 10);
  const ws   = parseInt(windSpd, 10);

  const validBase = !isNaN(inb) && inb >= 0 && inb <= 360 && !isNaN(alt) && alt > 0;
  const hasSpeed  = validBase && !isNaN(tasN) && tasN > 0;
  const hasHdg    = validBase && !isNaN(hdg) && hdg >= 0 && hdg <= 360;
  const hasWind   = hasSpeed && !isNaN(wd) && !isNaN(ws) && ws >= 0;

  const maxSpd   = validBase ? getMaxSpeed(cat, alt) : null;
  const legSecs  = validBase ? getLegTimeSecs(alt, chartedMin) : null;
  const entry    = hasHdg    ? getSectorEntry(hdg, inb, turnDir) : null;
  const windCalc = hasWind   ? calcWind(inb, wd, ws, tasN) : null;
  const outAdj   = hasWind   ? calcOutboundTime(inb, wd, ws, tasN, legSecs) : null;
  const speedWarn = hasSpeed && tasN > maxSpd;

  // ── Save / load ──
  const buildSnapshot = () => ({
    inboundTrack: inb, altitude: alt, turnDir, cat, tas: tasN,
    chartedMin: chartedMin || null, acHdg: hasHdg ? hdg : null,
    windDir: hasWind ? wd : null, windSpd: hasWind ? ws : null,
    sector: entry?.sector ?? null, sectorName: entry?.name ?? null,
    maxSpd, legSecs, savedAt: new Date().toISOString(),
  });

  const saveMemory = () => {
    if (!saveKey.trim() || !validBase) return;
    const k = saveKey.trim().toUpperCase();
    setMemories(p => ({ ...p, [k]: buildSnapshot() }));
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const loadMemory = (k) => {
    const m = memories[k];
    if (!m) return;
    if (!isNaN(m.inboundTrack)) setInboundTrack(String(m.inboundTrack));
    if (!isNaN(m.altitude))     setAltitude(String(m.altitude));
    if (m.turnDir)               setTurnDir(m.turnDir);
    if (m.cat)                   setCat(m.cat);
    if (!isNaN(m.tas) && m.tas)  setTas(String(m.tas));
    if (m.chartedMin)            setChartedMin(String(m.chartedMin));
    if (m.acHdg !== null)        setAcHdg(String(m.acHdg));
    if (m.windDir !== null)      setWindDir(String(m.windDir));
    if (m.windSpd !== null)      setWindSpd(String(m.windSpd));
    setSaveKey(k);
    setTab("calc");
  };

  const delMemory = (k) => {
    setMemories(p => { const n = { ...p }; delete n[k]; return n; });
    setDeleteConfirm(null);
  };

  const memKeys = Object.keys(memories)
    .filter(k => k.toLowerCase().includes(memSearch.toLowerCase()))
    .sort();

  // ─── Styles ───────────────────────────────────────────────────────────────
  const S = {
    app: {
      background: C.bg, minHeight: "100vh", color: C.text,
      fontFamily: "'SF Mono', 'Fira Mono', Consolas, monospace",
      fontSize: 13, paddingBottom: 60,
    },
    header: {
      background: C.surface, borderBottom: `1px solid ${C.border}`,
      padding: "16px 16px 12px",
      display: "flex", justifyContent: "space-between", alignItems: "center",
    },
    tabs: {
      display: "flex", borderBottom: `1px solid ${C.border}`,
      background: C.surface, overflowX: "auto",
    },
    tab: (active) => ({
      flex: 1, padding: "12px 10px", cursor: "pointer",
      fontSize: 9.5, letterSpacing: 2, fontFamily: "monospace", fontWeight: active ? 700 : 400,
      color: active ? C.accent : C.textSub,
      borderBottom: active ? `2px solid ${C.accent}` : "2px solid transparent",
      background: "none", border: "none", borderBottom: active ? `2px solid ${C.accent}` : "2px solid transparent",
      whiteSpace: "nowrap",
    }),
    body: { padding: "14px", maxWidth: 500, margin: "0 auto" },
    row2: { display: "flex", gap: 10, marginBottom: 10 },
    field: { flex: 1, display: "flex", flexDirection: "column" },
    segGroup: { display: "flex", gap: 6, marginBottom: 10 },
    stepItem: { display: "flex", gap: 9, marginBottom: 8, alignItems: "flex-start" },
    stepNum: {
      flexShrink: 0, width: 20, height: 20, borderRadius: "50%",
      background: C.accentDim, color: C.accent,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 9, fontWeight: 700,
    },
    stepText: { fontSize: 12, lineHeight: 1.6, color: C.text },
    warnBox: {
      background: "#2A1500", border: `1px solid #7A4000`, borderRadius: 8,
      padding: "10px 12px", fontSize: 11, color: C.accent, marginBottom: 10, lineHeight: 1.6,
    },
    notesBox: {
      background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6,
      padding: "10px 12px", fontSize: 10.5, color: C.textSub, lineHeight: 1.8, marginTop: 10,
    },
    memCard: {
      background: C.surfaceRaise, border: `1px solid ${C.border}`,
      borderRadius: 8, padding: "11px 13px", marginBottom: 8,
    },
    memActions: { display: "flex", gap: 6, marginTop: 10 },
    btnPrimary: {
      background: C.accentDim, border: `1px solid ${C.accent}`,
      borderRadius: 6, color: C.accent, cursor: "pointer",
      padding: "10px 16px", fontSize: 10.5, fontFamily: "monospace",
      fontWeight: 700, letterSpacing: 1.5, flexShrink: 0,
    },
    btnDanger: {
      background: C.redDim, border: `1px solid ${C.red}`,
      borderRadius: 6, color: C.red, cursor: "pointer",
      padding: "8px 12px", fontSize: 10, fontFamily: "monospace",
      fontWeight: 700, letterSpacing: 1,
    },
    btnNeutral: {
      background: C.surfaceHigh, border: `1px solid ${C.border}`,
      borderRadius: 6, color: C.textSub, cursor: "pointer",
      padding: "8px 12px", fontSize: 10, fontFamily: "monospace",
    },
    refSection: {
      background: C.surfaceRaise, border: `1px solid ${C.border}`,
      borderRadius: 8, padding: "12px 14px", marginBottom: 10,
    },
    refTitle: { fontSize: 9, letterSpacing: 2, color: C.textSub, textTransform: "uppercase", marginBottom: 10, fontFamily: "monospace" },
    refRow: { display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: `1px solid ${C.border}` },
    refLabel: { fontSize: 10.5, color: C.textSub },
    refVal: { fontSize: 10.5, color: C.text, fontWeight: 600 },
    sectorBadge: (col) => ({
      display: "inline-block", padding: "3px 12px", borderRadius: 12,
      fontSize: 10, fontWeight: 700, letterSpacing: 1.5,
      background: col + "18", color: col, border: `1px solid ${col}`,
      marginBottom: 10,
    }),
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={S.app}>

      {/* Header */}
      <div style={S.header}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.accent, letterSpacing: 3 }}>
            ✈ HOLDMASTER
          </div>
          <div style={{ fontSize: 9, color: C.textSub, letterSpacing: 2, marginTop: 2 }}>
            AU AIP ENR 1.5 · ICAO PANS-OPS
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <Pill color={C.green}>CASA COMPLIANT</Pill>
          {Object.keys(memories).length > 0 && (
            <Pill color={C.blue}>{Object.keys(memories).length} SAVED</Pill>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {[
          { id: "calc",  label: "CALCULATOR" },
          { id: "entry", label: "SECTOR ENTRY" },
          { id: "wind",  label: "WIND" },
          { id: "memory",label: "MEMORY" },
          { id: "ref",   label: "REFERENCE" },
        ].map(({ id, label }) => (
          <button key={id} style={S.tab(tab === id)} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      <div style={S.body}>

        {/* ── CALCULATOR TAB ── */}
        {tab === "calc" && (
          <>
            <Card>
              <CardTitle icon="◈">HOLD PARAMETERS</CardTitle>

              <div style={S.row2}>
                <div style={S.field}>
                  <Label>Inbound Track (°M)</Label>
                  <Input value={inboundTrack} onChange={e => setInboundTrack(e.target.value)}
                    placeholder="e.g. 152" />
                </div>
                <div style={S.field}>
                  <Label>Altitude (ft)</Label>
                  <Input value={altitude} onChange={e => setAltitude(e.target.value)}
                    placeholder="e.g. 8000" />
                </div>
              </div>

              <div style={{ marginBottom: 10 }}>
                <Label>Turn Direction</Label>
                <div style={{ display: "flex", gap: 8 }}>
                  <SegBtn active={turnDir === "R"} onClick={() => setTurnDir("R")}>▶ RIGHT (STANDARD)</SegBtn>
                  <SegBtn active={turnDir === "L"} onClick={() => setTurnDir("L")}>◀ LEFT</SegBtn>
                </div>
              </div>

              <div style={{ marginBottom: 10 }}>
                <Label>Aircraft Category (ICAO / AU AIP)</Label>
                <Select value={cat} onChange={e => setCat(e.target.value)}>
                  {Object.entries(ICAO_CATS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label} · Vat {v.vatRange} · Max {getMaxSpeed(k, alt || 0)}kt
                    </option>
                  ))}
                </Select>
              </div>

              <div style={S.row2}>
                <div style={S.field}>
                  <Label>TAS / IAS (knots)</Label>
                  <Input value={tas} onChange={e => setTas(e.target.value)} placeholder="e.g. 120" />
                </div>
                <div style={S.field}>
                  <Label>Charted Leg (min) or DME — override auto</Label>
                  <Input value={chartedMin} onChange={e => setChartedMin(e.target.value)}
                    placeholder="auto (1 or 1.5 min)" />
                </div>
              </div>
            </Card>

            {validBase && (
              <Card>
                <CardTitle icon="◈">HOLD TIMING</CardTitle>

                {speedWarn && (
                  <div style={S.warnBox}>
                    ⚠ {tasN}kt EXCEEDS Cat {cat} limit of {maxSpd}kt at this altitude.<br />
                    AIP ENR 1.5: reduce to ≤{maxSpd}kt BEFORE the fix.
                  </div>
                )}

                <DataRow label="FL / ALT" value={`${alt}ft · FL${Math.round(alt / 100)}`}
                  valueColor={alt / 100 > 140 ? C.s2 : C.green} large />
                <DataRow label="INBOUND TRACK" value={`${norm(inb)}°M`} valueColor={C.accent} large />
                <DataRow label="OUTBOUND HEADING" value={`${norm(inb + 180)}°M`} valueColor={C.accent} large />
                {windCalc && <>
                  <DataRow label="INBOUND HDG (wind corrected)"
                    value={`${norm(inb - windCalc.wca)}°M`} valueColor={C.blue} />
                  <DataRow label="OUTBOUND HDG (wind corrected)"
                    value={`${norm(norm(inb + 180) - windCalc.wca * 3)}°M`} valueColor={C.blue} />
                </>}
                <DataRow label="INBOUND LEG TIME"
                  value={alt / 100 <= 140 ? "1 MIN (≤FL140)" : "1.5 MIN (>FL140)"}
                  valueColor={C.accent} large />
                {outAdj
                  ? <DataRow label="ADJUSTED OUTBOUND LEG" value={fmtTime(outAdj.secs)} valueColor={C.blue} large />
                  : <DataRow label="STANDARD OUTBOUND LEG" value={fmtTime(legSecs)} />}
                <DataRow label={`MAX HOLD SPEED · CAT ${cat}`} value={`${maxSpd} KIAS`}
                  valueColor={speedWarn ? C.red : C.text} />
                {hasSpeed && <DataRow label="YOUR SPEED" value={`${tasN} kt`}
                  valueColor={speedWarn ? C.red : C.green} />}
                {outAdj && <>
                  <DataRow label="GS INBOUND" value={`${outAdj.gsIn} kt`} valueColor={C.blue} />
                  <DataRow label="GS OUTBOUND" value={`${outAdj.gsOut} kt`} valueColor={C.blue} />
                  <DataRow label="TARGET INBOUND DIST" value={`${outAdj.distNM} NM`} valueColor={C.blue} />
                </>}
                {windCalc && <>
                  <DataRow label="INBOUND WCA" value={`${windCalc.wca > 0 ? "+" : ""}${windCalc.wca}°`}
                    valueColor={C.blue} />
                  <DataRow label="OUTBOUND WCA (×3)"
                    value={`${windCalc.wca * 3 > 0 ? "+" : ""}${windCalc.wca * 3}°`}
                    valueColor={C.blue} />
                </>}

                <div style={S.notesBox}>
                  <div>• Timing starts ABEAM the fix or wings level after turn — whichever is later.</div>
                  <div>• Obtain inbound track BEFORE crossing the fix inbound. (ENR 1.5 para 3.1.5)</div>
                  <div>• Turns: standard rate; max bank 30° (flight director: 25°).</div>
                  {entry && <div>• Sector 2 max outbound: 1.5 min even if chart shows 1 min.</div>}
                </div>
              </Card>
            )}

            {/* Quick sector summary if computed */}
            {entry && (
              <Card style={{ borderColor: entry.borderColor }}>
                <CardTitle icon="◈">SECTOR ENTRY SUMMARY</CardTitle>
                <div style={S.sectorBadge(entry.color)}>{entry.badge}</div>
                <div style={{ fontSize: 12, color: C.textSub, marginBottom: 8 }}>
                  AC hdg {norm(hdg)}°M on inbound {norm(inb)}°M — {turnDir === "R" ? "right-hand" : "left-hand"} hold.
                </div>
                <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                  {entry.procedure.map((step, i) => (
                    <li key={i} style={S.stepItem}>
                      <span style={S.stepNum}>{i + 1}</span>
                      <span style={S.stepText}>{step}</span>
                    </li>
                  ))}
                </ul>
                <div style={{ ...S.notesBox, marginTop: 10 }}>
                  <div>Tap <strong style={{ color: C.accent }}>SECTOR ENTRY</strong> tab for the full diagram.</div>
                </div>
              </Card>
            )}

                        {/* Hold Card — kneeboard summary */}
            {validBase && (
              <Card style={{ borderColor: C.accent + "44", background: C.surfaceHigh }}>
                <CardTitle icon="✈">HOLD CARD</CardTitle>
                <div style={{
                  display: "grid", gridTemplateColumns: "1fr 1fr",
                  gap: "8px 16px", fontFamily: "monospace",
                }}>
                  {[
                    { l: "FIX INBOUND",   v: `${norm(inb)}°M`,             c: C.accent },
                    { l: "OUTBOUND",      v: `${norm(inb + 180)}°M`,        c: C.accent },
                    { l: "TURN",          v: turnDir === "R" ? "RIGHT ▶" : "◀ LEFT", c: C.green },
                    { l: "CAT",           v: cat,                            c: C.text },
                    { l: "ALT",           v: `${alt}ft / FL${Math.round(alt/100)}`, c: alt/100>140?C.s2:C.green },
                    { l: "LEG TIME",      v: alt/100<=140?"1 MIN":"1.5 MIN", c: C.accent },
                    ...(outAdj ? [
                      { l: "OBD LEG (adj)", v: fmtTime(outAdj.secs),       c: C.blue },
                      { l: "DIST",          v: `${outAdj.distNM} NM`,       c: C.blue },
                    ] : [
                      { l: "OBD LEG",     v: fmtTime(legSecs),             c: C.text },
                    ]),
                    { l: "MAX SPEED",     v: `${maxSpd} kt`,                c: speedWarn ? C.red : C.text },
                    ...(windCalc ? [
                      { l: "IBD HDG",     v: `${norm(inb - windCalc.wca)}°M`, c: C.blue },
                      { l: "OBD HDG",     v: `${norm(norm(inb+180) - windCalc.wca*3)}°M`, c: C.blue },
                      { l: "WCA ×3",      v: `${windCalc.wca*3>0?"+":""}${windCalc.wca*3}°`, c: C.blue },
                    ] : []),
                    ...(entry ? [
                      { l: "ENTRY",       v: entry.badge,                   c: entry.color },
                    ] : []),
                  ].map(({ l, v, c }) => (
                    <div key={l} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ fontSize: 8, color: C.textSub, letterSpacing: 1.5, textTransform: "uppercase" }}>{l}</span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: c }}>{v}</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Save to Memory */}
            <Card>
              <CardTitle icon="◈">SAVE TO MEMORY BANK</CardTitle>
              <div style={S.row2}>
                <div style={{ flex: 1 }}>
                  <Label>Label (airport / fix, e.g. YMAV · YMML-VOR)</Label>
                  <Input type="text" value={saveKey}
                    onChange={e => setSaveKey(e.target.value.toUpperCase())}
                    placeholder="e.g. YMAV" />
                </div>
                <button
                  style={{ ...S.btnPrimary, alignSelf: "flex-end", marginBottom: 0 }}
                  onClick={saveMemory}
                  disabled={!validBase || !saveKey.trim()}
                >
                  {saved ? "✓ SAVED" : "SAVE"}
                </button>
              </div>
            </Card>
          </>
        )}

        {/* ── SECTOR ENTRY TAB ── */}
        {tab === "entry" && (
          <>
            <Card>
              <CardTitle icon="◈">AIRCRAFT HEADING AT FIX</CardTitle>
              <div style={S.row2}>
                <div style={S.field}>
                  <Label>Inbound Track (°M)</Label>
                  <Input value={inboundTrack} onChange={e => setInboundTrack(e.target.value)}
                    placeholder="e.g. 152" />
                </div>
                <div style={S.field}>
                  <Label>Turn Direction</Label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <SegBtn active={turnDir === "R"} onClick={() => setTurnDir("R")}>R</SegBtn>
                    <SegBtn active={turnDir === "L"} onClick={() => setTurnDir("L")}>L</SegBtn>
                  </div>
                </div>
              </div>
              <div>
                <Label>AC Heading at Fix (°M)</Label>
                <Input value={acHdg} onChange={e => setAcHdg(e.target.value)}
                  placeholder="e.g. 342" />
              </div>
              <div style={{ fontSize: 10, color: C.textSub, marginTop: 8 }}>
                AIP ENR 1.5 para 3.4.1 — sector entry is determined by <strong style={{ color: C.text }}>heading</strong>, not ground track.
              </div>
            </Card>

            {/* Diagram */}
            {!isNaN(inb) && (
              <Card>
                <CardTitle icon="◈">HOLDING PATTERN SECTORS</CardTitle>
                <HoldDiagram
                  inboundTrack={inb}
                  turnDir={turnDir}
                  sector={entry?.sector ?? null}
                  acHdg={hasHdg ? hdg : null}
                />

                {/* Sector Legend */}
                <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 10, flexWrap: "wrap" }}>
                  {[
                    { n: 1, label: "S1 PARALLEL", col: C.s1 },
                    { n: 2, label: "S2 OFFSET", col: C.s2 },
                    { n: 3, label: "S3 DIRECT", col: C.s3 },
                  ].map(({ n, label, col }) => (
                    <span key={n} style={{
                      ...S.sectorBadge(col),
                      marginBottom: 0,
                      opacity: entry ? (entry.sector === n ? 1 : 0.4) : 1,
                    }}>
                      {label}
                    </span>
                  ))}
                </div>
              </Card>
            )}

            {/* Entry procedure */}
            {entry && (
              <Card style={{ borderColor: entry.borderColor }}>
                <CardTitle icon="◈">{entry.name.toUpperCase()}</CardTitle>
                <div style={S.sectorBadge(entry.color)}>{entry.badge}</div>
                <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                  {entry.procedure.map((step, i) => (
                    <li key={i} style={S.stepItem}>
                      <span style={S.stepNum}>{i + 1}</span>
                      <span style={S.stepText}>{step}</span>
                    </li>
                  ))}
                </ul>

                <div style={{ ...S.notesBox, marginTop: 12 }}>
                  <div style={{ fontWeight: 700, color: C.text, marginBottom: 4 }}>
                    Sector Boundaries (this hold):
                  </div>
                  <div>Outbound: {norm(inb + 180)}°M · Fix: {norm(inb)}°M inbound</div>
                  <div>S3/S1 line: {norm(norm(inb + 180) + (turnDir === "R" ? 110 : -110))}°M from fix</div>
                  <div>S1/S2 line: {norm(norm(inb + 180) + (turnDir === "R" ? 290 : -290))}°M from fix</div>
                  {entry.offsetHeading && (
                    <div style={{ marginTop: 4, color: C.accent }}>
                      Offset heading (S2): {entry.offsetHeading}°M
                    </div>
                  )}
                </div>
              </Card>
            )}

            {/* All 3 entries explained */}
            {!isNaN(inb) && (
              <Card>
                <CardTitle icon="◈">ALL THREE ENTRIES · {norm(inb)}°M INBOUND</CardTitle>
                {[
                  { sector: 1, acHdgExample: norm(norm(inb + 180) + (turnDir === "R" ? 200 : -200)) },
                  { sector: 2, acHdgExample: norm(norm(inb + 180) + (turnDir === "R" ? 320 : -320)) },
                  { sector: 3, acHdgExample: norm(norm(inb + 180) + (turnDir === "R" ? 55 : -55)) },
                ].map(({ sector: s, acHdgExample }) => {
                  const e = getSectorEntry(acHdgExample, inb, turnDir);
                  return (
                    <div key={s} style={{
                      background: C.bg, borderRadius: 6, padding: "10px 12px",
                      border: `1px solid ${e.borderColor}`, marginBottom: 8,
                    }}>
                      <div style={{ ...S.sectorBadge(e.color), marginBottom: 6 }}>{e.badge}</div>
                      <div style={{ fontSize: 11, color: C.textSub, lineHeight: 1.6 }}>
                        {e.procedure[0]}
                      </div>
                    </div>
                  );
                })}
              </Card>
            )}
          </>
        )}

        {/* ── WIND TAB ── */}
        {tab === "wind" && (
          <>
            <Card>
              <CardTitle icon="◈">WIND INPUT</CardTitle>
              <div style={S.row2}>
                <div style={S.field}>
                  <Label>Inbound Track (°M)</Label>
                  <Input value={inboundTrack} onChange={e => setInboundTrack(e.target.value)}
                    placeholder="e.g. 152" />
                </div>
                <div style={S.field}>
                  <Label>TAS (knots)</Label>
                  <Input value={tas} onChange={e => setTas(e.target.value)}
                    placeholder="e.g. 120" />
                </div>
              </div>
              <div style={S.row2}>
                <div style={S.field}>
                  <Label>Wind Direction (°T)</Label>
                  <Input value={windDir} onChange={e => setWindDir(e.target.value)}
                    placeholder="e.g. 270" />
                </div>
                <div style={S.field}>
                  <Label>Wind Speed (knots)</Label>
                  <Input value={windSpd} onChange={e => setWindSpd(e.target.value)}
                    placeholder="e.g. 20" />
                </div>
              </div>
            </Card>

            {hasWind && windCalc && (
              <>
                <Card>
                  <CardTitle icon="◈">INBOUND LEG</CardTitle>
                  <DataRow label="WIND COMPONENT" value={
                    windCalc.hw >= 0
                      ? `↗ TAILWIND ${windCalc.hw}kt`
                      : `↙ HEADWIND ${Math.abs(windCalc.hw)}kt`
                  } valueColor={windCalc.hw >= 0 ? C.green : C.red} large />
                  <DataRow label="CROSSWIND" value={`${Math.abs(windCalc.xw)}kt`} />
                  <DataRow label="WCA (INBOUND)" value={`${windCalc.wca > 0 ? "+" : ""}${windCalc.wca}°`}
                    valueColor={C.blue} />
                  <DataRow label="INBOUND HEADING"
                    value={`${norm(inb + windCalc.wca)}°M`}
                    valueColor={C.accent} large />
                  <DataRow label="GS INBOUND (approx)" value={`${windCalc.gsInbound}kt`} />
                </Card>

                <Card>
                  <CardTitle icon="◈">OUTBOUND LEG</CardTitle>
                  <DataRow label="WCA (OUTBOUND = ×3 inbound)" value={`${windCalc.wca * 3 > 0 ? "+" : ""}${windCalc.wca * 3}°`}
                    valueColor={C.blue} />
                  <DataRow label="OUTBOUND HEADING"
                    value={`${norm(norm(inb + 180) + windCalc.wca * 3)}°M`}
                    valueColor={C.accent} large />
                  <DataRow label="ADJUSTED OUTBOUND TIME"
                    value={outAdj ? fmtTime(outAdj.secs) : "—"}
                    valueColor={C.blue} large />
                  {outAdj && <>
                    <DataRow label="GS OUTBOUND (approx)" value={`${outAdj.gsOut}kt`} />
                    <DataRow label="TARGET INBOUND DIST" value={`${outAdj.distNM} NM`} valueColor={C.blue} />
                  </>}
                </Card>

                <Card>
                  <CardTitle icon="◈">WIND CORRECTION NOTES</CardTitle>
                  <div style={S.notesBox}>
                    <div>• Apply WCA on INBOUND: track {norm(inb)}°M → heading {norm(inb + windCalc.wca)}°M.</div>
                    <div>• Apply TRIPLE WCA on OUTBOUND: hdg {norm(norm(inb + 180) + windCalc.wca * 3)}°M.</div>
                    <div>• Adjust outbound timing so inbound leg = {legSecs ? fmtTime(legSecs) : "—"}.</div>
                    <div>• Lateral drift: re-evaluate each lap and refine corrections.</div>
                    <div>• (AU AIP ENR 1.5 para 3.1.4 — wind effect in holding)</div>
                  </div>
                </Card>
              </>
            )}

            {!hasWind && (
              <Card>
                <div style={{ color: C.textSub, fontSize: 12, textAlign: "center", padding: 20 }}>
                  Enter inbound track, TAS, and wind to see corrections.
                </div>
              </Card>
            )}
          </>
        )}

        {/* ── MEMORY TAB ── */}
        {tab === "memory" && (
          <>
            <Card>
              <CardTitle icon="◈">MEMORY BANK</CardTitle>
              <Input type="text" value={memSearch}
                onChange={e => setMemSearch(e.target.value)}
                placeholder="Search airport / label…" />
            </Card>

            {memKeys.length === 0 && (
              <Card>
                <div style={{ textAlign: "center", color: C.textMuted, padding: 24, fontSize: 12 }}>
                  {Object.keys(memories).length === 0
                    ? "No holds saved yet.\nUse CALCULATOR tab to set up and save a hold."
                    : "No results for that search."}
                </div>
              </Card>
            )}

            {memKeys.map(k => {
              const m = memories[k];
              const sc = m.sector;
              const scCol = sc === 1 ? C.s1 : sc === 2 ? C.s2 : sc === 3 ? C.s3 : C.textSub;
              const fl = m.altitude ? Math.round(m.altitude / 100) : null;
              return (
                <div key={k} style={S.memCard}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontSize: 17, fontWeight: 700, color: C.accent, marginBottom: 6 }}>{k}</div>
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 6 }}>
                        {m.inboundTrack && <Pill color={C.blue}>INBOUND {m.inboundTrack}°M</Pill>}
                        {fl && <Pill color={C.textSub}>FL{fl}</Pill>}
                        {m.cat && <Pill color={C.green}>CAT {m.cat}</Pill>}
                        {sc && <Pill color={scCol}>S{sc}</Pill>}
                        {m.turnDir && <Pill color={m.turnDir === "R" ? C.green : C.s2}>{m.turnDir === "R" ? "R/H" : "L/H"}</Pill>}
                        {m.tas && <Pill color={C.textSub}>{m.tas}kt</Pill>}
                        {m.maxSpd && <Pill color={C.red}>MAX {m.maxSpd}kt</Pill>}
                      </div>
                      {m.sectorName && (
                        <div style={{ fontSize: 10, color: scCol }}>{m.sectorName}</div>
                      )}
                    </div>
                  </div>

                  {/* Compact hold summary */}
                  <div style={{ ...S.notesBox, marginTop: 8 }}>
                    {m.inboundTrack && <div>Inbound {m.inboundTrack}°M → Outbound {norm(m.inboundTrack + 180)}°M</div>}
                    {m.altitude && <div>Alt {m.altitude}ft — leg: {m.altitude / 100 <= 140 ? "1 min" : "1.5 min"}</div>}
                    {m.windDir != null && m.windSpd != null && (
                      <div>Wind: {m.windDir}°/{m.windSpd}kt</div>
                    )}
                    <div style={{ color: C.textMuted, fontSize: 9, marginTop: 4 }}>
                      Saved {new Date(m.savedAt).toLocaleString("en-AU", { dateStyle: "short", timeStyle: "short" })}
                    </div>
                  </div>

                  <div style={S.memActions}>
                    <button style={S.btnPrimary} onClick={() => loadMemory(k)}>LOAD</button>
                    {deleteConfirm === k
                      ? <>
                          <button style={S.btnDanger} onClick={() => delMemory(k)}>CONFIRM DELETE</button>
                          <button style={S.btnNeutral} onClick={() => setDeleteConfirm(null)}>CANCEL</button>
                        </>
                      : <button style={S.btnDanger} onClick={() => setDeleteConfirm(k)}>DELETE</button>
                    }
                  </div>
                </div>
              );
            })}
          </>
        )}

        {/* ── REFERENCE TAB ── */}
        {tab === "ref" && (
          <>
            <Card>
              <CardTitle icon="◈">AU AIP ENR 1.5 SPEED LIMITS</CardTitle>
              <div style={S.notesBox}>
                Maximum IAS for holding, by ICAO category and altitude. (PANS-OPS Doc 8168)
              </div>
              {Object.entries(ICAO_CATS).map(([k, v]) => (
                <div key={k} style={S.refSection}>
                  <div style={S.refTitle}>{v.label} · Vat {v.vatRange}</div>
                  <div style={S.refRow}>
                    <span style={S.refLabel}>≤ FL140 (≤14,000ft)</span>
                    <span style={{ ...S.refVal, color: C.accent }}>{v.maxBelow14k} KIAS MAX</span>
                  </div>
                  <div style={{ ...S.refRow, borderBottom: "none" }}>
                    <span style={S.refLabel}>&gt; FL140</span>
                    <span style={{ ...S.refVal, color: C.accent }}>{v.maxAbove14k} KIAS MAX</span>
                  </div>
                </div>
              ))}
            </Card>

            <Card>
              <CardTitle icon="◈">LEG TIMING</CardTitle>
              <div style={S.refRow}>
                <span style={S.refLabel}>≤ FL140 (≤14,000ft)</span>
                <span style={{ ...S.refVal, color: C.accent }}>1 MINUTE outbound</span>
              </div>
              <div style={{ ...S.refRow }}>
                <span style={S.refLabel}>&gt; FL140</span>
                <span style={{ ...S.refVal, color: C.accent }}>1.5 MINUTES outbound</span>
              </div>
              <div style={{ ...S.refRow, borderBottom: "none" }}>
                <span style={S.refLabel}>Sector 2 (offset) max</span>
                <span style={{ ...S.refVal, color: C.s2 }}>1.5 MIN (overrides chart)</span>
              </div>
              <div style={S.notesBox}>
                Timing starts ABEAM the fix or at completion of turn — whichever is later. (ENR 1.5 para 3.1.2)
              </div>
            </Card>

            <Card>
              <CardTitle icon="◈">SECTOR ENTRY DEFINITIONS</CardTitle>
              {[
                {
                  sector: "S1 · PARALLEL", col: C.s1,
                  lines: [
                    "Aircraft heading within 180° arc on the NON-HOLDING side of the outbound.",
                    "Cross fix → fly parallel to inbound (non-holding side).",
                    "Turn holding-side (>180°) to intercept inbound.",
                  ]
                },
                {
                  sector: "S2 · OFFSET", col: C.s2,
                  lines: [
                    "Aircraft heading within 70° arc on the HOLDING SIDE of outbound.",
                    "Cross fix → fly 30° offset from outbound toward holding side.",
                    "Max outbound: 1.5 min (even if chart shows 1 min).",
                    "Turn to intercept inbound.",
                  ]
                },
                {
                  sector: "S3 · DIRECT", col: C.s3,
                  lines: [
                    "Aircraft heading within 110° arc on non-holding side of outbound.",
                    "Cross fix → immediately turn holding side.",
                    "Fly outbound, then turn to inbound.",
                  ]
                },
              ].map(({ sector: s, col, lines }) => (
                <div key={s} style={{ ...S.refSection, borderColor: col }}>
                  <div style={{ ...S.refTitle, color: col }}>{s}</div>
                  {lines.map((l, i) => (
                    <div key={i} style={{ fontSize: 11, color: i === 0 ? C.text : C.textSub, marginBottom: 4 }}>{l}</div>
                  ))}
                </div>
              ))}
            </Card>

            <Card>
              <CardTitle icon="◈">GENERAL RULES</CardTitle>
              <div style={S.notesBox}>
                <div>• Standard hold = RIGHT turns (unless chart specifies left). (ENR 1.5 para 3.1.3)</div>
                <div>• Sector entry based on HEADING at fix, not ground track. (ENR 1.5 para 3.4.1)</div>
                <div>• Bank angle: standard rate or max 30° (FD: 25°). (ENR 1.5 para 3.1.6)</div>
                <div>• Obtain inbound track BEFORE crossing fix inbound. (ENR 1.5 para 3.1.5)</div>
                <div>• Outbound WCA = 3× inbound WCA. (ENR 1.5 para 3.1.4)</div>
                <div>• Maintain last assigned altitude unless hold clearance specifies new alt.</div>
                <div>• DME/RNAV distance may substitute for timing where published.</div>
                <div>• AIP ENR 1.5 is based on ICAO PANS-OPS Doc 8168.</div>
              </div>
            </Card>

            <Card>
              <CardTitle icon="◈">APPROACH CATEGORY SPEEDS (TABLE 1.1)</CardTitle>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: "monospace" }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                      {["Cat", "Initial Appr", "Final Appr", "Visual Circuit", "Missed Appr"].map(h => (
                        <th key={h} style={{ padding: "6px 4px", color: C.textSub, textAlign: "left", letterSpacing: 1 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ["A", "90–150kt", "70–100kt", "100kt", "110kt"],
                      ["B", "120–180kt", "85–130kt", "135kt", "150kt"],
                      ["C", "160–240kt", "115–160kt", "180kt", "240kt"],
                      ["D", "185–250kt", "130–185kt", "205kt", "265kt"],
                      ["E", "185–250kt", "155–230kt", "240kt", "275kt"],
                    ].map(([c, ...vals]) => (
                      <tr key={c} style={{ borderBottom: `1px solid ${C.border}` }}>
                        <td style={{ padding: "6px 4px", color: C.accent, fontWeight: 700 }}>{c}</td>
                        {vals.map((v, i) => (
                          <td key={i} style={{ padding: "6px 4px", color: C.text }}>{v}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ ...S.notesBox, marginTop: 10 }}>
                Cat A max speed for reversal procedures: 110kt. AU AIP ENR 1.5 Table 1.1 / DAP IAL4.
              </div>
            </Card>
          </>
        )}

      </div>
    </div>
  );
}
