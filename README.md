# ✈ HoldMaster — Australian IFR Holding Pattern Calculator

> AU AIP ENR 1.5 / ICAO PANS-OPS compliant. Built for CPL/IREX candidates and IFR pilots.  
> Not for operational use — always cross-reference with current CASA AIP and DAP charts.

---

## Getting the app on your iPhone

**[→ Download the latest IPA from Releases](../../releases/latest)**

Every push to `main` triggers a GitHub Actions build on Apple's own macOS runners with real Xcode — this produces a genuinely compiled, real iOS binary (not a hand-built stub). The IPA is **unsigned**; your sideloading tool (SideStore, AltStore, LiveContainer) re-signs it locally with your own Apple ID on install. This is normal — Apple doesn't allow distributing pre-signed third-party apps outside the App Store.

### Sideloading
- **SideStore** — install SideStore, add the IPA from Releases, trust the cert in Settings → General → VPN & Device Management
- **LiveContainer** — copy the IPA into LiveContainer's apps folder, no signing needed
- **AltStore** — sideload via AltStore
- **PWA (no sideload)** — Safari → Share → Add to Home Screen, full offline support

### A note on earlier releases
Releases before v2.0 shipped a hand-assembled `.ipa` with a placeholder binary — it had the right file structure (Info.plist, icons, web assets) but no real compiled Mach-O executable, so it failed at the signing step (`unable to locate __LINKEDIT segment`). v2.0 replaces that with a proper Capacitor-generated Xcode project, built for real by CI. If you hit that error on an old release, grab the [latest one](../../releases/latest) instead.

---

## What's New — v3.0.0

Flight-planning tools, not just holding patterns — six new tabs, all fully offline.

| | Feature |
|---|---|
| ✈ | **AIRCRAFT** — save tail number, W&B arms, cruise TAS/fuel flow, and takeoff/landing charts once per aircraft |
| ✈ | **W&B** — station-by-station weight & balance, moment/CG calculation, MTOW and CG-limit checking with pass/fail status |
| ✈ | **PERF** — takeoff/landing distance via bilinear interpolation across your saved POH chart corners, plus pressure altitude / density altitude / ISA deviation |
| ✈ | **NAVLOG** — leg-by-leg route planner: track, distance, wind → heading, groundspeed, time, fuel burn, running totals, fuel remaining |
| ✈ | **WX** — fully offline METAR decoder: wind, visibility, cloud/ceiling, temp/dew, QNH, weather codes, trend, VFR/MVFR/IFR/LIFR categorisation |
| 🛠 | Aircraft profiles feed defaults into NAVLOG, W&B, and PERF automatically — set up once, use everywhere |
| 🛠 | Every formula (W&B moment/CG, density altitude, bilinear interpolation, wind-corrected leg calc) independently verified against textbook/training reference values before shipping |
| 🛠 | Fixed a tab-bar layout bug where 12 tabs would squash into the viewport instead of scrolling |

All v3.0 calculations are fully offline — no network dependency, no external data source. Enter your own POH/AFM numbers once per aircraft and they're reused for every flight.

## What's New — v2.0.0

| | Change |
|---|---|
| 🛠 | **Real compiled iOS builds** — full Capacitor + Xcode native project, built on GitHub Actions macOS runners |
| 🛠 | CI verifies the `__LINKEDIT` segment is present before packaging — guarantees the binary will pass signing |
| 🛠 | Automated release on every push to `main` — always-current IPA in Releases |
| 🛠 | Removed the old hand-built placeholder IPA |

## v1.4.0
📄 Plate Ingestion — upload any Airservices plate, Claude reads and auto-fills the Approach Brief · 📚 offline plate library · 📡 ATIS Decoder with go/no-go minima check

## v1.1.0
✈ Approach Brief Generator (NDB/RNP/ILS/VOR) · Hold Timer · Fuel Endurance · VDP Calculator · ATC Phraseology reference · sector algorithm fix for left-hand holds

---

## Features

| Tab | Feature |
|---|---|
| **HOLD** | Inbound/outbound headings, leg timing, speed limits, wind-corrected headings, fuel endurance, hold timer, HOLD CARD kneeboard summary |
| **SECTORS** | Live compass diagram, S1/S2/S3 sector wedges, aircraft heading overlay, step-by-step procedure |
| **WIND** | Inbound WCA, outbound triple-WCA, adjusted outbound time, GS estimates |
| **BRIEF** | NDB/RNP/ILS/VOR approach brief generator with ATIS decoder and VDP calculator |
| **PLATES** | Upload approach plates → Claude extracts all data → auto-fills Brief tab. Offline plate library |
| **NAVLOG** | Leg-by-leg route planner — track/distance/wind → heading, GS, time, fuel, running totals |
| **W&B** | Station weight & balance, moment/CG, MTOW and CG-limit checking |
| **PERF** | Takeoff/landing distance interpolation, pressure/density altitude, ISA deviation |
| **WX** | Offline METAR decoder with VFR/MVFR/IFR/LIFR categorisation |
| **AIRCRAFT** | Save per-aircraft W&B arms, cruise performance, and POH charts — reused across NAVLOG/W&B/PERF |
| **MEMORY** | Save/load/delete holds per airport label |
| **REF** | AIP ENR 1.5 speed tables, sector definitions, ATC phraseology, Table 1.1 approach speeds |

---

## Australian AIP ENR 1.5 Rules

### Sector Entry
```
Right hold: rel = norm(bearingFromFix − outbound)    [CW]
Left hold:  rel = norm(outbound − bearingFromFix)    [CCW, mirrored]

S3 (Direct):   rel ∈ [0°,   110°]
S1 (Parallel): rel ∈ (110°, 290°]
S2 (Offset):   rel ∈ (290°, 360°)
```

### Leg Timing
- ≤ FL140: 1 min · > FL140: 1.5 min · S2 max: always 1.5 min

### Max Holding Speeds
| Cat | ≤FL140 | >FL140 |
|---|---|---|
| A | 170 kt | 170 kt |
| B | 170 kt | 220 kt |
| C/D/E | 230 kt | 240 kt |

---

## Build from Source

### Web / PWA
```bash
npm install
npm run dev      # dev server
npm run build    # production → dist/
```

### iOS (requires macOS + Xcode locally, or just push to `main` and let CI do it)
```bash
npm run build
npx cap sync ios
npx cap open ios       # opens Xcode — Product ▸ Archive to build/sign
```

Node.js ≥ 18 required.

---

## Project Structure

```
holdmaster/
├── .github/workflows/
│   └── build-ipa.yml    # CI: builds + verifies + releases a real IPA
├── ios/
│   └── App/              # Native Capacitor Xcode project (Swift + xcodeproj)
├── src/
│   ├── App.jsx           # Full app — all logic + UI
│   ├── main.jsx
│   └── index.css
├── public/
│   ├── manifest.json     # PWA manifest
│   └── icon-*.png
├── index.html
├── vite.config.js
└── capacitor.config.ts
```

---

## How the CI build works

1. Checkout → `npm install` → `npm run build` (Vite web bundle)
2. `npx cap sync ios` — copies web assets into the native project
3. Xcode resolves Swift Package dependencies (Capacitor's Swift runtime)
4. `xcodebuild ... clean build` — compiles a real arm64 `.app`, code-signing disabled (no dev team attached to this repo)
5. **Verification step**: `otool -l` confirms the `__LINKEDIT` segment exists — this is the exact thing that was missing before and caused sideloading to fail
6. Packages `Payload/HoldMaster.app` into `HoldMaster.ipa`
7. Publishes as a GitHub Release, tagged `build-<run number>`

Your sideloading tool signs the unsigned binary with your own certificate on install — that's the standard, Apple-sanctioned way to run non-App-Store apps.

---

*Not approved for operational use. AIP ENR 1.5 © Airservices Australia.*
