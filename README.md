# ✈ HoldMaster — Australian IFR Holding Pattern Calculator

> A publishable iOS sideload-ready app for CASA AIP ENR 1.5 compliant holding calculations.  
> Built by a CPL candidate. Not for operational use — always cross-reference with current AIP.

---

## Features

| Feature | Detail |
|---|---|
| **Holding Calculator** | Inbound track, altitude, category, turn direction, charted/default leg time |
| **Sector Entry** | Full S1/S2/S3 per AIP ENR 1.5 para 3.4.1 — based on **heading** not track |
| **Visual Diagram** | Live compass rose with sector wedges, aircraft heading arrow, racetrack oval |
| **Wind Corrections** | Inbound WCA, outbound triple-WCA, adjusted outbound time, GS estimates |
| **Max Speed Warnings** | Per ICAO Cat A–E, altitude-aware (≤FL140 / >FL140) |
| **Memory Bank** | Save holds per airport/fix label; reload with one tap; persistent via `localStorage` |
| **Reference Tab** | Full AIP ENR 1.5 speed table, sector definitions, Table 1.1 approach speeds |

---

## Australian AIP ENR 1.5 Rules Implemented

### Leg Timing
- **≤ FL140**: 1 minute outbound (or published DME)
- **> FL140**: 1.5 minutes outbound (or published DME)
- **Sector 2 (offset)**: max 1.5 min *even if* the chart shows 1 min

### Max Holding Speeds (ICAO PANS-OPS / AU AIP)
| Cat | Vat | ≤ FL140 | > FL140 |
|---|---|---|---|
| A | ≤90kt | 170 KIAS | 170 KIAS |
| B | 91–120kt | 170 KIAS | 220 KIAS |
| C | 121–140kt | 230 KIAS | 240 KIAS |
| D | 141–165kt | 230 KIAS | 240 KIAS |
| E | 166–210kt | 230 KIAS | 240 KIAS |

### Sector Entry Algorithm
Sectors defined by **bearing from the fix** relative to the **outbound direction**:

```
For right-hand hold, outbound = inbound + 180°:
  S3 (Direct):   bearing [outbound,     outbound+110°]  CW  → 110° arc
  S1 (Parallel): bearing [outbound+110, outbound+290°]  CW  → 180° arc  
  S2 (Offset):   bearing [outbound+290, outbound+360°]  CW  → 70°  arc
```

For **left-hand** holds, the arcs mirror (CCW direction).  
Entry based on **aircraft heading at the fix**, not ground track. (ENR 1.5 para 3.4.1)

### Sector 2 — Offset Heading
30° from outbound toward the **holding side**:
- Right hold: `offset = outbound − 30°`
- Left hold:  `offset = outbound + 30°`

---

## Sideloading on iPhone (No Mac Required)

### Method 1: SideStore (recommended)
1. Install [SideStore](https://sidestore.io) on your iPhone
2. Add `HoldMaster.ipa` from this repo's [Releases](../../releases)
3. Sideload and trust the developer certificate

### Method 2: LiveContainer
1. Install [LiveContainer](https://github.com/khanhduytran0/LiveContainer)
2. Copy `HoldMaster.ipa` to your LiveContainer apps folder
3. Launch from LiveContainer

### Method 3: AltStore
1. Install [AltStore](https://altstore.io) (requires PC/Mac for initial setup)
2. Sideload `HoldMaster.ipa` via AltStore

### Method 4: Add to Home Screen (PWA — no sideload needed)
If you just want it as an app icon without sideloading:
1. Clone this repo and run locally, OR deploy to any static host
2. Open in Safari on iPhone → Share → **Add to Home Screen**
3. Full offline support via service worker

---

## Build from Source

```bash
# Install dependencies
npm install

# Development server
npm run dev

# Production build
npm run build

# The built files are in dist/ — sideload-ready IPA is in the repo Releases
```

### Requirements
- Node.js ≥ 18
- npm ≥ 9

---

## Project Structure

```
holdmaster/
├── src/
│   ├── App.jsx          # Main app (all logic + UI, ~1200 lines)
│   └── main.jsx         # React entry point
├── public/
│   ├── manifest.json    # PWA manifest
│   └── icon-*.png       # App icons
├── index.html           # iOS PWA meta tags, safe-area CSS
├── vite.config.js       # Vite + PWA plugin config
├── capacitor.config.ts  # iOS app metadata
├── HoldMaster.ipa       # Pre-built IPA for sideloading
└── HoldingCalc.jsx      # Standalone React component (importable)
```

---

## Tabs

| Tab | Purpose |
|---|---|
| **CALCULATOR** | Enter all hold params; get timing, speed limits, warnings |
| **SECTOR ENTRY** | Interactive diagram with live aircraft heading overlay |
| **WIND** | WCA, triple-WCA, adjusted outbound time, GS |
| **MEMORY** | Save/load/delete holds by airport label |
| **REFERENCE** | Full AIP ENR 1.5 speed tables and rules |

---

## Legal

Not approved for operational use. Always verify against current CASA AIP, relevant DAP charts, and aircraft Flight Manual.  
AIP ENR 1.5 © Airservices Australia.

---

## Author

Built for personal CPL/IREX study.  
Corrections welcome via Issues.
