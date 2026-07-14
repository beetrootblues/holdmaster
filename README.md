# ✈ HoldMaster — Australian IFR Holding Pattern Calculator

> AU AIP ENR 1.5 / ICAO PANS-OPS compliant. Built for CPL/IREX candidates and IFR pilots.  
> Not for operational use — always cross-reference with current CASA AIP and DAP charts.

---

## What's New — v1.4.0

| | Feature |
|---|---|
| 📄 | **Plate Ingestion** — upload any Airservices plate (PDF/photo), Claude reads it and auto-fills the entire Approach Brief |
| 📚 | **Plate Library** — ingested plates saved offline, tap to reload any approach instantly |
| 📡 | **ATIS Decoder** — paste raw ATIS string, get parsed wind/QNH/ceiling/vis with go/no-go minima check |
| ✈ | Plate ingestion auto-populates: frequencies, MSA, fix names, hold details, check heights, minima, missed approach |
| ✈ | ATIS ceiling and visibility checked against your entered DA/MDA — green/amber/red banner |
| ✈ | ATIS wind automatically available to Wind tab calculations |

## v1.1.0

| | Feature |
|---|---|
| ✈ | **Approach Brief Generator** — NDB · RNP · ILS · VOR verbatim read-back quality brief |
| ✈ | **Hold Timer** — abeam countdown → inbound count-up with colour cues |
| ✈ | **Fuel Endurance in Hold** — laps available, endurance, fuel per lap |
| ✈ | **VDP Calculator** — (MDA−TDZE)÷300 with timing at TAS |
| ✈ | **ATC Phraseology** crib in Reference tab |
| ✈ | Sector algorithm fixed for left-hand holds |
| ✈ | Wind calculation bug fixes |

---

## Features

| Tab | Feature |
|---|---|
| **HOLD** | Inbound/outbound headings, leg timing, speed limits, wind-corrected headings, fuel endurance, hold timer, HOLD CARD kneeboard summary |
| **SECTORS** | Live compass diagram, S1/S2/S3 sector wedges, aircraft heading overlay, step-by-step procedure |
| **WIND** | Inbound WCA, outbound triple-WCA, adjusted outbound time, GS estimates |
| **BRIEF** | NDB/RNP/ILS/VOR approach brief generator with ATIS decoder and VDP calculator |
| **PLATES** | Upload approach plates → Claude extracts all data → auto-fills Brief tab. Offline plate library |
| **MEMORY** | Save/load/delete holds per airport label |
| **REF** | AIP ENR 1.5 speed tables, sector definitions, ATC phraseology, Table 1.1 approach speeds |

---

## Plate Ingestion

Upload any Airservices Australia approach plate — PDF page, photo, or scan. Claude's vision reads:

- All frequencies (ATIS, TWR, APP, CTAF, PAL, CEN, SMC)
- MSA and aerodrome elevation
- Navaid frequency and ident
- IAF / IF / FAF fix names
- Hold fix, inbound track, turn direction, minimum altitude
- Outbound track and timing
- Check heights table
- DA/MDA, AGL, visibility (LNAV, LNAV+VNAV, LOC-only, circling)
- Missed approach track, altitude, procedure
- Chart date

Plates are stored in the local library (up to 50 plates). Tap any saved plate to instantly reload the entire brief.

## ATIS Decoder

Paste raw ATIS string (e.g. `YMML INFO GOLF 281750 WIND 280/12 VIS 8KM FEW030 SCT050 TEMP 14 DEW 09 QNH 1013 RWY 27`):

- Parses wind direction/speed/gust, visibility, ceiling layers, QNH, temp/dew, runway in use, trend
- Compares ceiling and visibility against your entered approach minima
- **Green** = above minima · **Amber** = marginal · **Red** = below minima

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

## Sideloading

**SideStore** (recommended) — install SideStore, add `HoldMaster.ipa` from Releases  
**LiveContainer** — copy IPA to LiveContainer apps folder  
**PWA** — Safari → Share → Add to Home Screen (full offline support)

## Build

```bash
npm install && npm run dev    # dev
npm run build                 # production → dist/
```

Node.js ≥ 18 required.

---

*Not approved for operational use. AIP ENR 1.5 © Airservices Australia.*
