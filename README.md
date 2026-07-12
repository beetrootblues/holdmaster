# ✈ HoldMaster — Australian IFR Holding Pattern Calculator

> AU AIP ENR 1.5 / ICAO PANS-OPS compliant. Built for CPL/IREX candidates and IFR pilots.  
> Not for operational use — always cross-reference with current CASA AIP and DAP charts.

---

## What's New — v1.1.0

| | Feature |
|---|---|
| ✈ | **Approach Brief Generator** — NDB · RNP · ILS · VOR verbatim read-back quality brief |
| ✈ | **Hold Timer** — abeam countdown → inbound count-up with colour cues |
| ✈ | **Fuel Endurance in Hold** — laps available, endurance, fuel per lap |
| ✈ | **VDP Calculator** — (MDA−TDZE)÷300 with timing at TAS |
| ✈ | **ATC Phraseology** crib in Reference tab |
| ✈ | Sector algorithm fixed for left-hand holds (BFF-mirrored geometry) |
| ✈ | Wind calculation bug fixed (gsInbound/outbound sign error) |

---

## Features

| Tab | Feature |
|---|---|
| **HOLD** | Inbound/outbound headings, leg timing, speed limits, wind-corrected headings, fuel endurance, hold timer, HOLD CARD kneeboard summary |
| **SECTORS** | Live compass diagram, S1/S2/S3 sector wedges, aircraft heading overlay, step-by-step procedure |
| **WIND** | Inbound WCA, outbound triple-WCA, adjusted outbound time, GS estimates |
| **BRIEF** | NDB/RNP/ILS/VOR approach brief generator — frequencies, navaid, sector entry, check heights, minima, alternate, missed approach, VDP |
| **MEMORY** | Save/load/delete holds per airport label (localStorage) |
| **REF** | AIP ENR 1.5 speed tables, sector definitions, ATC phraseology, Table 1.1 approach speeds |

---

## Approach Brief Generator

Generates a verbatim, read-back quality brief in the format used by Australian IFR operators:

**NDB** — navaid tuning, MSA, sector entry with station passage procedure, hold, outbound/descent track, check heights, MDA/AGL/vis, circling minima, alternate, missed approach  
**RNP** — GNSS cross-check, IAF/IF/FAF fix names, transition track, check height table, LNAV and LNAV+VNAV minima  
**ILS** — ILS freq/ident, G/S and LOC fail actions, check heights, DA/AGL/vis, LOC-only minima, outside-TWR-hours missed approach  
**VOR** — VOR tuning, outbound track/time, stabilised note, check heights, MDA with/without ATIS, VOR fail action  

All types include auto-derived sector entry from heading inputs, outbound timing (TW/nil wind/HW seconds), and VDP for non-precision approaches.

---

## Australian AIP ENR 1.5 Rules

### Leg Timing
- **≤ FL140**: 1 minute outbound
- **> FL140**: 1.5 minutes outbound  
- **Sector 2 (offset)**: max 1.5 min regardless of chart timing

### Sector Entry Algorithm
Using bearing-from-fix (BFF) relative to outbound direction, mirrored for left holds:

```
Right hold: rel = norm(bearingFromFix − outbound)      [CW]
Left hold:  rel = norm(outbound − bearingFromFix)      [CCW, mirrored]

S3 (Direct):   rel ∈ [0°,   110°]   — 110° arc
S1 (Parallel): rel ∈ (110°, 290°]   — 180° arc
S2 (Offset):   rel ∈ (290°, 360°)   —  70° arc
```

Entry is based on **aircraft heading at the fix**, not ground track. (AIP ENR 1.5 para 3.4.1)

### Max Holding Speeds
| Cat | Vat | ≤FL140 | >FL140 |
|---|---|---|---|
| A | ≤90kt | 170 KIAS | 170 KIAS |
| B | 91–120kt | 170 KIAS | 220 KIAS |
| C | 121–140kt | 230 KIAS | 240 KIAS |
| D | 141–165kt | 230 KIAS | 240 KIAS |
| E | 166–210kt | 230 KIAS | 240 KIAS |

---

## Sideloading on iPhone

### SideStore (recommended — no PC needed after setup)
1. Install [SideStore](https://sidestore.io)
2. Add `HoldMaster.ipa` from [Releases](../../releases)
3. Trust the certificate in Settings → General → VPN & Device Management

### LiveContainer (no signing required)
1. Install [LiveContainer](https://github.com/khanhduytran0/LiveContainer)
2. Copy `HoldMaster.ipa` to LiveContainer's apps folder
3. Launch from LiveContainer

### AltStore
1. Install [AltStore](https://altstore.io)
2. Sideload `HoldMaster.ipa` via AltStore

### PWA (no sideload — add to Home Screen)
Open in Safari → Share → **Add to Home Screen** → full offline support via service worker.

---

## Build from Source

```bash
npm install
npm run dev      # dev server
npm run build    # production build → dist/
```

Node.js ≥ 18 required.

---

## Project Structure

```
holdmaster/
├── src/
│   ├── App.jsx          # Full app — 1500+ lines, all logic + UI
│   ├── main.jsx
│   └── index.css
├── public/
│   ├── manifest.json    # PWA manifest
│   └── icon-*.png
├── index.html           # iOS PWA meta tags + safe-area CSS
├── vite.config.js       # Vite + PWA plugin
├── capacitor.config.ts  # iOS native build config
└── HoldMaster.ipa       # Pre-built IPA
```

---

## Legal

Not approved for operational use. Always verify against current CASA AIP, DAP charts, and your aircraft's Flight Manual. AIP ENR 1.5 © Airservices Australia.

## Author

CPL candidate, Moorabbin. Corrections welcome via Issues.
