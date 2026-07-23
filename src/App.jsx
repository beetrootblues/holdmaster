import { useState, useEffect, useRef, useCallback } from "react";

// ─── Version ──────────────────────────────────────────────────────────────────
const VERSION = "3.0.0";

// ─── AU AIP ENR 1.5 / ICAO PANS-OPS Speed Table ──────────────────────────────
const ICAO_CATS = {
  A: { label: "Cat A", vatRange: "≤90kt", maxBelow14k: 170, maxAbove14k: 170 },
  B: { label: "Cat B", vatRange: "91–120kt", maxBelow14k: 170, maxAbove14k: 220 },
  C: { label: "Cat C", vatRange: "121–140kt", maxBelow14k: 230, maxAbove14k: 240 },
  D: { label: "Cat D", vatRange: "141–165kt", maxBelow14k: 230, maxAbove14k: 240 },
  E: { label: "Cat E", vatRange: "166–210kt", maxBelow14k: 230, maxAbove14k: 240 },
};

// ─── Core maths ───────────────────────────────────────────────────────────────
const norm = (a) => ((a % 360) + 360) % 360;

function getSectorEntry(acHdg, inboundTrack, turnDir) {
  const outbound = norm(inboundTrack + 180);
  const bearingFromFix = norm(acHdg + 180);
  // BFF-mirrored: CW for right hold, CCW for left hold (mirrors the pattern geometry)
  const rel = turnDir === "R"
    ? norm(bearingFromFix - outbound)   // CW from outbound
    : norm(outbound - bearingFromFix);  // CCW from outbound (mirrored for left hold)
  const offsetHeading = turnDir === "R" ? norm(outbound - 30) : norm(outbound + 30);
  if (rel <= 110) return {
    sector: 3, name: "Sector 3 — Direct Entry", badge: "S3 · DIRECT",
    color: "#3DAF76", bgColor: "#0D2D1C", borderColor: "#3DAF76",
    offsetHeading,
    procedure: [
      `Cross the fix and turn immediately ${turnDir === "R" ? "RIGHT" : "LEFT"} (holding side).`,
      `Fly outbound on ${norm(inboundTrack + 180)}°M for the published time/DME.`,
      `Turn ${turnDir === "R" ? "RIGHT" : "LEFT"} onto inbound track ${norm(inboundTrack)}°M.`,
      `Establish inbound and cross the fix to commence the hold.`,
    ],
  };
  if (rel <= 290) return {
    sector: 1, name: "Sector 1 — Parallel Entry", badge: "S1 · PARALLEL",
    color: "#4D8FC9", bgColor: "#1B2D45", borderColor: "#4D8FC9",
    offsetHeading,
    procedure: [
      `Cross the fix and turn to fly PARALLEL to the inbound (${norm(inboundTrack)}°M) on the NON-HOLDING side.`,
      `Fly outbound parallel for the published time/distance.`,
      `Turn ${turnDir === "R" ? "LEFT" : "RIGHT"} through MORE than 180° to intercept inbound.`,
      `Track inbound ${norm(inboundTrack)}°M to the fix.`,
    ],
  };
  return {
    sector: 2, name: "Sector 2 — Offset Entry", badge: "S2 · OFFSET",
    color: "#E8A020", bgColor: "#3A2800", borderColor: "#E8A020",
    offsetHeading,
    procedure: [
      `Cross the fix and turn to fly offset heading ${offsetHeading}°M (30° from outbound toward holding side).`,
      `Fly offset for up to the published time (max 1.5 min even if chart shows 1 min — AIP ENR 1.5).`,
      `Turn ${turnDir === "R" ? "RIGHT" : "LEFT"} to intercept inbound track ${norm(inboundTrack)}°M.`,
      `Establish inbound and cross fix.`,
    ],
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
  const m = Math.floor(Math.abs(secs) / 60);
  const s = Math.abs(secs) % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function calcWind(inbTrack, windDir, windSpd, tas) {
  const inbRad = (inbTrack * Math.PI) / 180;
  const wRad = (windDir * Math.PI) / 180;
  const hw = windSpd * Math.cos(wRad - inbRad); // positive = tailwind on inbound
  const xw = windSpd * Math.sin(wRad - inbRad);
  const wcaDeg = Math.round(Math.atan2(xw, tas) * (180 / Math.PI));
  const gsInbound = Math.round(Math.sqrt(Math.max(0, tas * tas - xw * xw)) + hw);
  return { hw: Math.round(hw), xw: Math.round(xw), wca: wcaDeg, gsInbound };
}

function calcOutboundTime(inbTrack, windDir, windSpd, tas, stdLegSecs) {
  const outbTrack = norm(inbTrack + 180);
  const outbRad = (outbTrack * Math.PI) / 180;
  const wRad = (windDir * Math.PI) / 180;
  const hwOut = windSpd * Math.cos(wRad - outbRad); // positive = tailwind on outbound
  const xw = windSpd * Math.sin(wRad - outbRad);
  const spd = Math.sqrt(Math.max(1, tas * tas - xw * xw));
  const gsOut = spd + hwOut;
  const gsIn  = spd - hwOut;
  if (gsIn <= 0) return { secs: stdLegSecs, note: "GS too low" };
  const distNM = (stdLegSecs / 3600) * gsIn;
  const outSecs = Math.round((distNM / gsOut) * 3600);
  return { secs: outSecs, distNM: distNM.toFixed(2), gsIn: Math.round(gsIn), gsOut: Math.round(gsOut) };
}

// ─── Approach Brief Generator ─────────────────────────────────────────────────
function generateBrief(b, sectorEntry, windCalc) {
  const lines = [];
  const icao  = b.icao?.toUpperCase() || "????";
  const name  = b.aeroName || icao;
  const type  = b.approachType || "NDB";
  const rwy   = b.runway || "??";
  const date  = b.chartDate || "??";
  const ob    = norm((parseInt(b.holdInbound) || 0) + 180);

  // Sector entry spoken sentence
  const inb      = parseInt(b.holdInbound) || 0;
  const acH      = parseInt(b.acHdgAtFix) || 0;
  const turnDir  = b.holdTurnDir || "L";
  const outbOB   = norm(inb + 180);
  const legLabel = b.holdAlt && parseInt(b.holdAlt) / 100 > 140 ? "1 min 30 seconds" : "1 minute";

  // TW / nil / HW outbound timing
  const twSecs  = b.twSecs  || "5";
  const nilSecs = b.nilSecs || "15";
  const hwSecs  = b.hwSecs  || "20";

  // --- Header ---
  lines.push(`${name} ${type} Chart Brief`);
  lines.push(`${"─".repeat(50)}`);

  // --- What we're doing ---
  lines.push(`• We're doing: ${icao} ${type} RWY ${rwy}, dated ${date}`);

  // --- Frequencies ---
  if (b.freqs?.length) {
    const fStr = b.freqs.filter(f => f.label && f.freq).map(f => `${f.label}: ${f.freq}`).join(" | ");
    lines.push(`• Frequencies have been set (${fStr})`);
  }

  // --- Navaid ---
  if (type === "NDB") {
    lines.push(`• NDB has been tuned for ${b.ndbFreq || "???"} | ${b.ndbIdent || "???"}`);
  } else if (type === "ILS") {
    lines.push(`• ILS has been tuned, tested and identified for ${b.ilsFreq || "???"} | ${b.ilsIdent || "???"}`);
  } else if (type === "VOR") {
    lines.push(`• VOR has been tuned, tested and identified for ${b.vorFreq || "???"} | ${b.vorIdent || "???"}`);
  } else if (type === "RNP") {
    lines.push(`• RNP approach has been programmed and cross-checked in the GNSS unit`);
  }

  // --- MSA / Elevation ---
  lines.push(`• ${b.msaDist || "10"}NM MSA is ${b.msa || "???"}ft, Aerodrome Elevation is ${b.aeroElev || "???"}ft`);

  // --- Sector Entry ---
  const se = sectorEntry || (b.acHdgAtFix ? getSectorEntry(acH, inb, turnDir) : null);
  if (se) {
    if (type === "RNP") {
      const iaf = b.iafFix || "the IAF";
      lines.push(`• In the event of a Sector Entry [I will OBS the GNS Flight Plan]: Tracking inbound ${b.acHdgAtFix || "???"}° to the ${iaf}, I will execute a ${se.name}. Upon station passage, I will turn to ${outbOB}°, and push out for either ${twSecs}s (TW), ${nilSecs}s (nil wind) or ${hwSecs}s (HW), then turn ${turnDir === "L" ? "right" : "left"} to ${inb}° (uncorrected for wind).`);
    } else if (type === "ILS") {
      const iafFix = b.iafFix || "the IAF";
      lines.push(`• In the event of a Sector Entry: Tracking via ${b.acHdgAtFix || "???"}° to ${iafFix}, I will execute a ${se.name}. Upon station passage at ${iafFix}, I will turn to an outbound heading of ${outbOB}° for ${twSecs}s / ${nilSecs}s / ${hwSecs}s, then make a ${turnDir === "R" ? "right" : "left"} turn to ${se.sector === 2 ? se.offsetHeading : outbOB}° outbound CRS. After ${b.holdLeg || "1 minute"} Std Hold, I'll turn ${turnDir === "R" ? "right" : "left"} to track ${inb}° inbound CRS towards ${iafFix}.`);
    } else {
      // NDB / VOR
      let entryText = "";
      if (se.sector === 1) {
        entryText = `Upon station passage, I will turn to track ${outbOB}° outbound for ${nilSecs} seconds, then ${turnDir === "R" ? "left" : "right"} onto ${se.offsetHeading}°, and back ${inb}° inbound.`;
      } else if (se.sector === 2) {
        entryText = `Upon station passage, I will turn slightly ${turnDir === "R" ? "right" : "left"} to ${se.offsetHeading}°, push out for ${b.s2OutboundTime || "1 minute 15 seconds"}, and then turn ${turnDir === "R" ? "left" : "right"} to ${inb}°. Upon attaining station passage again, I will turn ${turnDir === "R" ? "left" : "right"}, and fly ${inb}° uncorrected.`;
      } else {
        entryText = `Upon station passage, I will turn to ${outbOB}°, and push out for either ${twSecs}s (TW), ${nilSecs}s (nil wind) or ${hwSecs}s (HW), then turn ${turnDir === "R" ? "right" : "left"} to ${inb}° (uncorrected).`;
      }
      lines.push(`• In the event of a Sector Entry: ${b.approachDesc || `I will be flying in at ${b.acHdgAtFix || "???"}°`}, I will execute a ${se.name}. ${entryText}`);
    }
  }

  // --- Holding Pattern ---
  const turnLabel = turnDir === "L" ? "non-standard left turn" : "standard right turn";
  const holdFix = b.holdFix || (type === "NDB" ? b.ndbIdent : type === "VOR" ? `${b.vorIdent || "???"} VOR` : b.iafFix || "the fix");
  lines.push(`• Holding pattern${b.holdFix ? ` at ${holdFix}` : ""} is ${turnLabel}, inbound ${inb}°, minimum altitude of ${b.holdAlt || "???"}ft.`);

  // --- Procedure Track / Descent ---
  if (type === "NDB") {
    lines.push(`• Upon completion of the hold, I plan to fly ${b.outboundTrack || outbOB}° outbound for ${b.outboundTime || "???"}${b.outboundTime ? " minutes" : ""} descending from ${b.descentFrom || "???"}ft to at or above ${b.descentTo || "???"}ft. I will then make a ${b.finalTurnDir || "right"} turn to track ${b.finalInbound || "???"}° inbound towards the runway.`);
    if (b.checkHeights?.length && b.checkHeights[0].alt) {
      const chStr = b.checkHeights.map(h => `${h.dist ? h.dist + "NM" : ""} ${h.alt}ft`).filter(x => x.trim()).join(", ");
      lines.push(`• Check-heights: ${chStr}.`);
    } else {
      lines.push(`• Check-heights are not applicable on this approach profile, just to maintain ${b.descentRate || "500"}fpm descent rate.`);
    }
    lines.push(`• I will continue my descent down to an MDA of ${b.mda || "???"}ft (${b.mdaAgl || "???"}ft AGL), with ${b.visibility || "???"}km visibility.${b.circlingMda ? ` If circling is required, MDA is ${b.circlingMda}ft with ${b.circlingVis || "???"}km visibility.` : ""}`);
  } else if (type === "RNP") {
    const trans = b.transitionTrack || inb;
    const transNM = b.transitionNM || "5";
    const ifFix = b.ifFix || "the IF";
    const fafFix = b.fafFix || "the FAF";
    lines.push(`• Upon completion of the hold, I plan to fly the transition track of ${trans}° for ${transNM}NM to ${ifFix} (IF), starting my descent from ${b.descentFrom || "???"}ft to ${b.descentTo || "???"}ft, then turn ${b.finalTurnDir || "right"} to track ${b.finalInbound || "???"}° inbound towards ${fafFix} (FAF). At ${b.gearDist || "0.5"}NM prior to ${fafFix}, I will bring gears down, set ${b.powerConfig || "16'' / 2300 RPM"} to intercept the ${b.descentAngle || "3"}° descent profile.`);
    if (b.checkHeights?.length && b.checkHeights.some(h => h.alt)) {
      const first = b.checkHeights[0];
      const rest  = b.checkHeights.slice(1).filter(h => h.alt);
      lines.push(`• Check height at ${fafFix} is ${first.alt}ft.${rest.length ? ` Subsequent profile check heights are ${rest.map(h => `${h.dist ? h.dist + "NM" : ""}${h.nmLabel ? ` at ` : " "}${h.alt}ft`).join(", ")}.` : ""}`);
    }
    lines.push(`• I will continue my descent down to the LNAV MDA of ${b.lnavMda || "???"}ft${b.lnavMdaAtis ? ` / ${b.lnavMdaAtis}ft` : ""}${b.lnavVis ? ` @ ${b.lnavVis}km VIS` : ""}${b.atisNote ? ` with ${b.atisNote}` : ""}.`);
    if (b.lnavVnavDa) {
      lines.push(`• (${b.lnavVnavNote || "If LNAV/VNAV is utilised"}, DA is ${b.lnavVnavDa}ft${b.lnavVnavVis ? ` with ${b.lnavVnavVis}km visibility` : ""}).`);
    }
  } else if (type === "ILS") {
    const iafFix = b.iafFix || "the IAF";
    const iafDme = b.iafDme ? ` (${b.iafDme} DME)` : "";
    lines.push(`• Upon completion of the hold, I plan to continue flying ${inb}° inbound with the ILS tuned and GPS set to VLOC. Upon passing ${iafFix}${iafDme} and at half dot high on the glide slope, I will bring gears down, set ${b.powerConfig || "16'' / 2300 RPM"} to intercept the G/S.`);
    if (b.gsFail) lines.push(`• If G/S fails, we will continue with the localiser approach using check-heights.${b.locFail ? ` If the localiser fails, we will go missed and carry out the ${b.locFail}.` : ""}`);
    if (b.checkHeights?.length && b.checkHeights.some(h => h.alt)) {
      const first = b.checkHeights[0];
      const rest  = b.checkHeights.slice(1).filter(h => h.alt);
      lines.push(`• Check height at ${first.fix || b.chkFix || "the check point"}${first.dme ? ` / ${first.dme}` : ""} is ${first.alt}ft.${rest.length ? ` Subsequent: ${rest.map(h => `${h.fix||""}${h.dme?"/"+h.dme:""} ${h.alt}ft`).join(", ")}.` : ""}`);
    }
    lines.push(`• I will continue my descent down to a DA of ${b.da || "???"}ft (${b.daAgl || "???"}ft AGL), visibility ${b.daVis || "???"}${b.daVisNote ? ` ${b.daVisNote}` : ""}.`);
    if (b.locOnlyMda) lines.push(`• If we're doing the localiser-only approach, the MDA is ${b.locOnlyMda}ft (${b.locOnlyAgl || "???"}ft AGL), ${b.locOnlyVis || "???"}km visibility.`);
  } else if (type === "VOR") {
    lines.push(`• Upon completion of the hold, I plan to track ${b.outboundTrack || outbOB}° outbound${b.catNote ? ` (${b.catNote})` : ""} for ${b.outboundTime || "???"}${b.outboundTime ? " minutes" : ""} while descending from ${b.descentFrom || "???"}ft to at or above ${b.descentTo || "???"}ft. I will then make a ${b.finalTurnDir || "left"} turn inbound to track ${b.finalInbound || "???"}° to establish on the final approach track into ${rwy}.`);
    if (b.stabilisedNote) lines.push(`• ${b.stabilisedNote}`);
    if (b.vorFail) lines.push(`• ${b.vorFail}`);
    if (b.checkHeights?.length && b.checkHeights.some(h => h.alt)) {
      const chStr = b.checkHeights.map(h => `${h.dist ? h.dist + "NM" : ""} ${h.alt}ft`).filter(x => x.trim()).join(", ");
      lines.push(`• Check heights: ${chStr}.`);
    } else {
      lines.push(`• DME Distance Table / Check heights is not applicable for reference on this plate.`);
    }
    lines.push(`• I will continue my descent down to an MDA of ${b.mda || "???"}ft${b.mdaAtis ? `, ${b.mdaAtis}ft with ATIS` : ""}${b.visibility ? `, ${b.visibility}km visibility` : ""}${b.atisNote ? ` which we have today` : ""}.`);
  }

  // --- Alternate ---
  if (b.alternateReqd === "no" || !b.alternateReqd) {
    lines.push(`• Alternate is not required today${b.alternateReason ? ` based on ${b.alternateReason}` : ""}.`);
  } else {
    lines.push(`• Alternate is ${b.alternateDest || "required"}.${b.alternateReason ? ` Reason: ${b.alternateReason}.` : ""}`);
  }

  // --- Missed Approach ---
  const maTrack  = b.missedTrack || "???";
  const maAlt    = b.missedAlt   || "???";
  const maDetail = b.missedDetail || "";
  if (type === "ILS") {
    lines.push(`• For a missed approach, I will track ${maTrack}° climbing to ${maAlt}ft.${b.missedOutsideTWR ? ` Outside TWR hours: ${b.missedOutsideTWR}` : ""}${maDetail ? ` ${maDetail}` : ""}`);
  } else if (type === "RNP") {
    const maFix = b.missedFix || "";
    lines.push(`• For a missed approach, I will track ${maFix ? `DCT to ${maFix}, track ` : ""}${maTrack}°, and climb to ${maAlt}ft.${maDetail ? ` ${maDetail}` : ""}`);
  } else {
    const maTurn = b.missedTurn || "right";
    lines.push(`• For a missed approach, I will turn ${maTurn}. Track ${maTrack}°, and climb to ${maAlt}ft.${maDetail ? ` ${maDetail}` : ""}`);
  }

  return lines.join("\n");
}

// ─── ATIS Parser ─────────────────────────────────────────────────────────────
function parseATIS(raw) {
  if (!raw || raw.trim().length < 10) return null;
  const s = raw.toUpperCase().trim();
  const result = {};

  // Airport ICAO
  const icaoM = s.match(/^([A-Z]{4})\s+(?:INFO|ATIS)/);
  if (icaoM) result.icao = icaoM[1];

  // Info identifier (Alpha, Bravo, etc or A/B/C...)
  const infoM = s.match(/INFO\s+([A-Z])/);
  if (infoM) result.info = infoM[1];

  // Time
  const timeM = s.match(/(\d{6})Z?/);
  if (timeM) result.time = timeM[1];

  // Wind: WIND 280/12 or 28012KT or CALM
  const windM = s.match(/WIND\s+(\d{3})\/(\d{1,3})|(\d{5})(?:G\d{2,3})?KT|CALM/);
  if (windM) {
    if (windM[0] === 'CALM') { result.windDir = 0; result.windSpd = 0; }
    else if (windM[1]) { result.windDir = parseInt(windM[1]); result.windSpd = parseInt(windM[2]); }
    else if (windM[3]) { result.windDir = parseInt(windM[3].slice(0,3)); result.windSpd = parseInt(windM[3].slice(3,5)); }
  }

  // Gust
  const gustM = s.match(/G(\d{2,3})KT/);
  if (gustM) result.gust = parseInt(gustM[1]);

  // Visibility: VIS 8KM or 9999 or 5000M or CAVOK
  if (s.includes('CAVOK')) { result.vis = 9999; result.cavok = true; }
  else {
    const visM = s.match(/VIS(?:IBILITY)?\s+(\d+(?:\.\d+)?)\s*KM|(\d{4})(?:\s|$)/);
    if (visM) result.vis = visM[1] ? parseFloat(visM[1]) * 1000 : parseInt(visM[2]);
  }

  // Ceiling / cloud: FEW030 SCT050 BKN025 OVC010
  const cloudM = [...s.matchAll(/(FEW|SCT|BKN|OVC)(\d{3})/g)];
  if (cloudM.length) {
    result.clouds = cloudM.map(m => ({ cover: m[1], alt: parseInt(m[2]) * 100 }));
    const ceiling = cloudM.find(m => m[1] === 'BKN' || m[1] === 'OVC');
    if (ceiling) result.ceiling = parseInt(ceiling[2]) * 100;
  }

  // Temperature / Dew point: TEMP 14 DEW 09 or 14/09
  const tempM = s.match(/TEMP\s+(\d+)|(\d{2})\/(\d{2})(?:\s|$)/);
  if (tempM) {
    result.temp = tempM[1] ? parseInt(tempM[1]) : parseInt(tempM[2]);
    if (tempM[3]) result.dew = parseInt(tempM[3]);
  }
  const dewM = s.match(/DEW(?:\s+POINT)?\s+(\d+)/);
  if (dewM) result.dew = parseInt(dewM[1]);

  // QNH
  const qnhM = s.match(/QNH\s*(\d{3,4})/);
  if (qnhM) result.qnh = parseInt(qnhM[1]);

  // Runway in use
  const rwyM = s.match(/(?:RWY|RUNWAY)\s+(\d{2}[LRC]?)/g);
  if (rwyM) result.runways = rwyM.map(r => r.replace(/(?:RWY|RUNWAY)\s+/, ''));

  // TREND
  const trendM = s.match(/TREND\s+(NOSIG|BECMG|TEMPO)/);
  if (trendM) result.trend = trendM[1];

  // Altimeter setting note
  if (s.includes('IN HG') || s.match(/A\d{4}/)) {
    const altM = s.match(/A(\d{4})/);
    if (altM) result.qnhInHg = parseInt(altM[1]) / 100;
  }

  return result;
}

function atisMinimaClear(parsed, mda, daVis) {
  // Returns 'go' | 'no-go' | 'marginal' | null
  if (!parsed || (!parsed.ceiling && !parsed.vis)) return null;
  const minAlt = parseFloat(mda);
  const minVis = parseFloat(daVis) * 1000; // convert km to m
  if (!minAlt && !minVis) return null;
  const ceilOk = !parsed.ceiling || parsed.ceiling > minAlt + 200;
  const visOk  = !parsed.vis    || parsed.vis >= minVis;
  const ceilMarginal = parsed.ceiling && parsed.ceiling > minAlt && parsed.ceiling <= minAlt + 200;
  const visMarginal  = parsed.vis     && parsed.vis >= minVis * 0.8 && parsed.vis < minVis;
  if (!ceilOk || !visOk) return 'no-go';
  if (ceilMarginal || visMarginal) return 'marginal';
  return 'go';
}

// ─── v3.0 — Weight & Balance ──────────────────────────────────────────────────
function calcWB(items) {
  // items: [{ name, weight, arm }]
  let totalWeight = 0, totalMoment = 0;
  const rows = items.map(it => {
    const w = parseFloat(it.weight) || 0;
    const a = parseFloat(it.arm) || 0;
    const moment = w * a;
    totalWeight += w;
    totalMoment += moment;
    return { ...it, weightNum: w, armNum: a, moment };
  });
  const cg = totalWeight > 0 ? totalMoment / totalWeight : 0;
  return { rows, totalWeight, totalMoment, cg };
}

// ─── v3.0 — Performance Interpolation ────────────────────────────────────────
function bilinearInterp(x, y, x1, x2, y1, y2, q11, q21, q12, q22) {
  // q11=f(x1,y1), q21=f(x2,y1), q12=f(x1,y2), q22=f(x2,y2)
  const denom = (x2 - x1) * (y2 - y1);
  if (denom === 0) return q11;
  const cx = Math.max(x1, Math.min(x2, x)); // clamp to table bounds
  const cy = Math.max(y1, Math.min(y2, y));
  const term1 = q11 * (x2 - cx) * (y2 - cy);
  const term2 = q21 * (cx - x1) * (y2 - cy);
  const term3 = q12 * (x2 - cx) * (cy - y1);
  const term4 = q22 * (cx - x1) * (cy - y1);
  return (term1 + term2 + term3 + term4) / denom;
}

function pressureAltitude(fieldElevFt, qnhHpa) {
  return fieldElevFt + (1013.25 - qnhHpa) * 27;
}

function densityAltitude(pressureAltFt, oatC) {
  const isaTemp = 15 - (pressureAltFt / 1000) * 1.98;
  const isaDev = oatC - isaTemp;
  return pressureAltFt + 120 * isaDev;
}

function isaTempAt(pressureAltFt) {
  return 15 - (pressureAltFt / 1000) * 1.98;
}

// ─── v3.0 — NAVLOG Leg Calculation ────────────────────────────────────────────
function calcNavLeg(track, distNM, windDir, windSpd, tas, fuelFlowPerHr) {
  const trackRad = (track * Math.PI) / 180;
  const windRad = (windDir * Math.PI) / 180;
  const hw = windSpd * Math.cos(windRad - trackRad); // positive = tailwind
  const xw = windSpd * Math.sin(windRad - trackRad);
  const wca = Math.round(Math.atan2(xw, tas) * (180 / Math.PI));
  const gs = Math.max(1, Math.round(Math.sqrt(Math.max(1, tas * tas - xw * xw)) + hw));
  const timeHrs = distNM / gs;
  const timeMin = Math.round(timeHrs * 60 * 10) / 10;
  const fuelUsed = Math.round(fuelFlowPerHr * timeHrs * 10) / 10;
  const heading = norm(track - wca);
  return { wca, gs, timeMin, fuelUsed, heading, hw: Math.round(hw), xw: Math.round(xw) };
}

function fmtHM(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = Math.round(totalMin % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

// ─── v3.0 — METAR/TAF Parser ──────────────────────────────────────────────────
function parseMETAR(raw) {
  if (!raw || raw.trim().length < 10) return null;
  const s = raw.toUpperCase().trim().replace(/^(METAR|SPECI)\s+/, "");
  const result = { raw: s };

  const icaoM = s.match(/^([A-Z]{4})\s/);
  if (icaoM) result.icao = icaoM[1];

  const timeM = s.match(/(\d{6})Z/);
  if (timeM) result.time = timeM[1];

  if (s.includes("CAVOK")) {
    result.cavok = true;
    result.vis = 9999;
  }

  const windM = s.match(/(\d{3})(\d{2,3})(?:G(\d{2,3}))?KT/) || s.match(/VRB(\d{2,3})KT/);
  if (windM) {
    if (s.includes("VRB")) {
      result.windVariable = true;
      result.windSpd = parseInt(windM[1]);
    } else {
      result.windDir = parseInt(windM[1]);
      result.windSpd = parseInt(windM[2]);
      if (windM[3]) result.gust = parseInt(windM[3]);
    }
  }

  if (!result.cavok) {
    const visM = s.match(/\s(\d{4})\s/);
    if (visM) result.vis = parseInt(visM[1]);
  }

  const cloudM = [...s.matchAll(/(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?/g)];
  if (cloudM.length) {
    result.clouds = cloudM.map(m => ({ cover: m[1], alt: parseInt(m[2]) * 100, type: m[3] || null }));
    const ceiling = cloudM.find(m => m[1] === "BKN" || m[1] === "OVC");
    if (ceiling) result.ceiling = parseInt(ceiling[2]) * 100;
  }

  const tempM = s.match(/(M?\d{2})\/(M?\d{2})\s/);
  if (tempM) {
    result.temp = parseInt(tempM[1].replace("M", "-"));
    result.dew = parseInt(tempM[2].replace("M", "-"));
  }

  const qnhM = s.match(/Q(\d{4})/);
  if (qnhM) result.qnh = parseInt(qnhM[1]);
  const altM = s.match(/A(\d{4})/);
  if (altM && !qnhM) result.qnhInHg = parseInt(altM[1]) / 100;

  const wxCodes = s.match(/\b(?:[+-]?(?:VC)?(?:MI|BC|PR|DR|BL|SH|TS|FZ)?(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+)\b/g);
  if (wxCodes) result.weather = [...new Set(wxCodes)];

  if (s.includes("NOSIG")) result.trend = "NOSIG";
  else if (s.match(/\bBECMG\b/)) result.trend = "BECMG";
  else if (s.match(/\bTEMPO\b/)) result.trend = "TEMPO";

  return result;
}

function flightCategory(vis, ceiling) {
  // Australian-style VMC/IMC categorisation (simplified, VFR/MVFR/IFR/LIFR bands)
  if (vis === undefined && ceiling === undefined) return null;
  const v = vis ?? 9999;
  const c = ceiling ?? 99999;
  if (v < 1600 || c < 500) return { cat: "LIFR", color: "#D94F4F" };
  if (v < 5000 || c < 1000) return { cat: "IFR", color: "#E8A020" };
  if (v < 8000 || c < 3000) return { cat: "MVFR", color: "#4D8FC9" };
  return { cat: "VFR", color: "#3DAF76" };
}

// ─── Colour palette ─────────────────────────────────────────────────────────────
const C = {
  bg:           "#0B0D12",
  surface:      "#131620",
  surfaceRaise: "#181C28",
  surfaceHigh:  "#1E2335",
  border:       "#242840",
  borderLight:  "#2E3450",
  accent:       "#E8A020",
  accentDim:    "#6B4A10",
  blue:         "#4D8FC9",
  blueDim:      "#1A3050",
  green:        "#3DAF76",
  greenDim:     "#122B1E",
  red:          "#D94F4F",
  redDim:       "#2D1010",
  purple:       "#9B72CF",
  purpleDim:    "#2A1A45",
  text:         "#DCE0EC",
  textSub:      "#6E7590",
  textMuted:    "#3E4460",
  s1:           "#4D8FC9",
  s2:           "#E8A020",
  s3:           "#3DAF76",
};

// Module-level shared styles (used by v3.0 tab components defined outside HoldMaster)
const S3 = {
  warnBox:  { background: "#2A1500", border: `1px solid #7A4000`, borderRadius: 8, padding: "10px 12px", fontSize: 11, color: C.accent, marginBottom: 10, lineHeight: 1.6 },
  notesBox: { background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "10px 12px", fontSize: 10.5, color: C.textSub, lineHeight: 1.8, marginTop: 10 },
};

// ─── SVG Holding Diagram ──────────────────────────────────────────────────────
function HoldDiagram({ inboundTrack, turnDir, sector, acHdg }) {
  const cx = 110, cy = 110, R = 110;
  const toXY = (bearingDeg, r) => {
    const a = ((bearingDeg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const outbound = norm(inboundTrack + 180);
  const sign = turnDir === "R" ? 1 : -1;
  const arcPath = (startBearing, sweep, r, col, opacity = 0.15) => {
    const steps = Math.max(2, Math.round(sweep / 5));
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const br = norm(startBearing + (i / steps) * sweep * sign);
      const [x, y] = toXY(br, r);
      pts.push(`${x},${y}`);
    }
    return (
      <polygon points={`${cx},${cy} ${pts.join(" ")}`}
        fill={col} fillOpacity={opacity} stroke={col}
        strokeOpacity={opacity * 1.5} strokeWidth={0.5} />
    );
  };
  const ovalAngleDeg = inboundTrack - 90;
  return (
    <svg viewBox="0 0 220 220" style={{ width: "100%", maxWidth: 220, display: "block", margin: "0 auto" }}>
      <defs>
        <marker id="arrowAmber" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
          <path d="M0,0 L7,3.5 L0,7 Z" fill={C.accent} />
        </marker>
        <marker id="arrowRed" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
          <path d="M0,0 L7,3.5 L0,7 Z" fill="#FF6060" />
        </marker>
      </defs>
      <circle cx={cx} cy={cy} r={R - 2} fill={C.surface} />
      <circle cx={cx} cy={cy} r={R - 2} fill="none" stroke={C.border} strokeWidth={1} />
      {Array.from({ length: 36 }, (_, i) => {
        const br = i * 10, isMajor = br % 30 === 0;
        const [x1, y1] = toXY(br, R - 8), [x2, y2] = toXY(br, R - (isMajor ? 18 : 13));
        const labels = { 0: "N", 90: "E", 180: "S", 270: "W" };
        const [lx, ly] = toXY(br, R - 24);
        return (
          <g key={br}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={isMajor ? C.textSub : C.textMuted} strokeWidth={isMajor ? 1.2 : 0.6} />
            {labels[br] && <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" fontSize="8" fill={C.textSub} fontFamily="monospace" fontWeight="bold">{labels[br]}</text>}
          </g>
        );
      })}
      {arcPath(outbound, 110, R - 30, C.s3)}
      {arcPath(norm(outbound + sign * 110), 180, R - 30, C.s1)}
      {arcPath(norm(outbound + sign * 290), 70, R - 30, C.s2)}
      {sector === 3 && arcPath(outbound, 110, R - 30, C.s3, 0.35)}
      {sector === 1 && arcPath(norm(outbound + sign * 110), 180, R - 30, C.s1, 0.35)}
      {sector === 2 && arcPath(norm(outbound + sign * 290), 70, R - 30, C.s2, 0.35)}
      {[norm(outbound + sign * 110), norm(outbound + sign * 290)].map((br, i) => {
        const [lx, ly] = toXY(br, R - 30);
        return <line key={i} x1={cx} y1={cy} x2={lx} y2={ly} stroke={C.borderLight} strokeWidth={1} strokeDasharray="3 2" />;
      })}
      {(() => { const [ox, oy] = toXY(outbound, R - 30); return <line x1={cx} y1={cy} x2={ox} y2={oy} stroke={C.accent} strokeWidth={1} strokeDasharray="4 3" opacity={0.5} />; })()}
      <g transform={`rotate(${ovalAngleDeg} ${cx} ${cy})`}>
        <ellipse cx={cx} cy={cy} rx={22} ry={45} fill="none" stroke={C.accent} strokeWidth={1.8} strokeOpacity={0.8} />
      </g>
      <circle cx={cx} cy={cx} r={3.5} fill={C.accent} opacity={0.9} />
      <text x={cx} y={cx - 8} textAnchor="middle" fontSize="6.5" fill={C.accent} fontFamily="monospace">FIX</text>
      {(() => { const [ax, ay] = toXY(norm(inboundTrack + 180), R * 0.55); return <line x1={ax} y1={ay} x2={cx} y2={cx} stroke={C.accent} strokeWidth={2} markerEnd="url(#arrowAmber)" opacity={0.9} />; })()}
      {acHdg !== null && (() => { const [ax, ay] = toXY(norm(acHdg + 180), R * 0.48), [bx, by] = toXY(acHdg, R * 0.8); return <line x1={ax} y1={ay} x2={bx} y2={by} stroke="#FF6060" strokeWidth={2.2} markerEnd="url(#arrowRed)" strokeDasharray="5 2" opacity={0.9} />; })()}
      {[{ br: norm(outbound + sign * 55), label: "S3", col: C.s3 }, { br: norm(outbound + sign * 200), label: "S1", col: C.s1 }, { br: norm(outbound + sign * 325), label: "S2", col: C.s2 }].map(({ br, label, col }) => { const [lx, ly] = toXY(br, R * 0.6); return <text key={label} x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" fontSize="10" fontWeight="bold" fill={col} fontFamily="monospace" opacity={0.85}>{label}</text>; })}
      {(() => { const [lx, ly] = toXY(norm(inboundTrack + 180), R * 0.42); return <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" fontSize="7" fill={C.accent} fontFamily="monospace">{norm(inboundTrack)}°M</text>; })()}
      <text x={4} y={212} fontSize="6.5" fill="#FF6060" fontFamily="monospace">▶ AC HDG</text>
      <text x={66} y={212} fontSize="6.5" fill={C.accent} fontFamily="monospace">▶ INBOUND</text>
    </svg>
  );
}

// ─── Shared UI primitives ─────────────────────────────────────────────────────
const Label = ({ children }) => (
  <div style={{ fontSize: 9, letterSpacing: 1.8, color: C.textSub, textTransform: "uppercase", marginBottom: 5, fontFamily: "monospace" }}>{children}</div>
);
const Input = ({ value, onChange, placeholder, type = "number", style = {} }) => (
  <input type={type} value={value} onChange={onChange} placeholder={placeholder}
    style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, padding: "10px 12px", fontSize: 15, fontFamily: "monospace", width: "100%", boxSizing: "border-box", outline: "none", WebkitAppearance: "none", ...style }}
    onFocus={e => (e.target.style.borderColor = C.accent)}
    onBlur={e => (e.target.style.borderColor = C.border)} />
);
const Select = ({ value, onChange, children, style = {} }) => (
  <select value={value} onChange={onChange}
    style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, padding: "10px 12px", fontSize: 13, fontFamily: "monospace", width: "100%", boxSizing: "border-box", outline: "none", WebkitAppearance: "none", ...style }}>
    {children}
  </select>
);
const SegBtn = ({ active, onClick, children }) => (
  <button onClick={onClick} style={{ flex: 1, padding: "10px 6px", background: active ? C.accentDim : C.bg, border: `1px solid ${active ? C.accent : C.border}`, borderRadius: 6, color: active ? C.accent : C.textSub, cursor: "pointer", fontSize: 11, fontFamily: "monospace", fontWeight: active ? 700 : 400, letterSpacing: 1 }}>
    {children}
  </button>
);
const Card = ({ children, style = {} }) => (
  <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 14px", marginBottom: 12, ...style }}>{children}</div>
);
const CardTitle = ({ icon, children }) => (
  <div style={{ fontSize: 9, letterSpacing: 2.5, color: C.textSub, textTransform: "uppercase", marginBottom: 12, display: "flex", alignItems: "center", gap: 7, fontFamily: "monospace" }}>
    <span style={{ color: C.accent, fontSize: 11 }}>{icon}</span>{children}
  </div>
);
const DataRow = ({ label, value, valueColor = C.text, large = false }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
    <span style={{ fontSize: 10, color: C.textSub, letterSpacing: 1.2, fontFamily: "monospace" }}>{label}</span>
    <span style={{ fontSize: large ? 18 : 14, fontWeight: 700, color: valueColor, fontFamily: "monospace" }}>{value}</span>
  </div>
);
const Pill = ({ color, children }) => (
  <span style={{ display: "inline-block", padding: "2px 9px", borderRadius: 10, fontSize: 9, background: color + "22", color, border: `1px solid ${color}`, letterSpacing: 1.2, fontWeight: 700, fontFamily: "monospace" }}>{children}</span>
);
const Divider = ({ label }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "12px 0 8px" }}>
    <div style={{ flex: 1, height: 1, background: C.border }} />
    {label && <span style={{ fontSize: 8, color: C.textMuted, letterSpacing: 2, fontFamily: "monospace" }}>{label}</span>}
    <div style={{ flex: 1, height: 1, background: C.border }} />
  </div>
);

// ─── Hold Timer Component ─────────────────────────────────────────────────────
function HoldTimer({ legSecs, outAdjSecs }) {
  const targetSecs = outAdjSecs || legSecs || 60;
  const [phase, setPhase] = useState("idle"); // idle | outbound | inbound
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(null);
  const rafRef   = useRef(null);

  const tick = useCallback(() => {
    const now = Date.now();
    setElapsed(Math.floor((now - startRef.current) / 1000));
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const start = () => {
    startRef.current = Date.now();
    setElapsed(0);
    setPhase("outbound");
    rafRef.current = requestAnimationFrame(tick);
  };

  const nextPhase = () => {
    if (phase === "outbound") {
      startRef.current = Date.now();
      setElapsed(0);
      setPhase("inbound");
      rafRef.current = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(rafRef.current);
      setPhase("idle");
      setElapsed(0);
    }
  };

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const remaining = targetSecs - elapsed;
  const overshot  = remaining < 0;
  const pct       = Math.min(1, elapsed / targetSecs);

  let timerColor = C.accent;
  let timerLabel = "";
  if (phase === "outbound") {
    timerColor = overshot ? C.red : elapsed > targetSecs * 0.85 ? C.green : C.accent;
    timerLabel = overshot ? `OVERSHOT ${fmtTime(Math.abs(remaining))}` : fmtTime(remaining);
  } else if (phase === "inbound") {
    timerColor = C.blue;
    timerLabel = fmtTime(elapsed);
  }

  return (
    <Card>
      <CardTitle icon="⏱">HOLD TIMER</CardTitle>
      <div style={{ fontSize: 10, color: C.textSub, marginBottom: 12 }}>
        Target outbound: <strong style={{ color: C.accent }}>{fmtTime(targetSecs)}</strong>
        {outAdjSecs && outAdjSecs !== legSecs && <span style={{ color: C.textMuted }}> (wind-adjusted)</span>}
      </div>

      {/* Progress arc */}
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
        <svg viewBox="0 0 120 120" style={{ width: 120 }}>
          <circle cx={60} cy={60} r={50} fill="none" stroke={C.border} strokeWidth={8} />
          {phase !== "idle" && (
            <circle cx={60} cy={60} r={50} fill="none"
              stroke={timerColor} strokeWidth={8}
              strokeDasharray={`${2 * Math.PI * 50}`}
              strokeDashoffset={`${2 * Math.PI * 50 * (phase === "inbound" ? 0 : 1 - pct)}`}
              strokeLinecap="round"
              style={{ transformOrigin: "60px 60px", transform: "rotate(-90deg)", transition: "stroke 0.3s" }} />
          )}
          <text x={60} y={55} textAnchor="middle" fontSize={phase === "idle" ? "11" : "22"}
            fontWeight="700" fill={phase === "idle" ? C.textSub : timerColor} fontFamily="monospace">
            {phase === "idle" ? "READY" : timerLabel}
          </text>
          {phase !== "idle" && (
            <text x={60} y={74} textAnchor="middle" fontSize="9" fill={C.textSub} fontFamily="monospace">
              {phase === "outbound" ? "OUTBOUND" : "INBOUND"}
            </text>
          )}
        </svg>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        {phase === "idle"
          ? <button onClick={start} style={{ flex: 1, background: C.accentDim, border: `1px solid ${C.accent}`, borderRadius: 6, color: C.accent, cursor: "pointer", padding: "12px", fontSize: 12, fontFamily: "monospace", fontWeight: 700, letterSpacing: 1.5 }}>
              START (ABEAM / WINGS LEVEL)
            </button>
          : <>
              <button onClick={nextPhase} style={{ flex: 1, background: C.blueDim, border: `1px solid ${C.blue}`, borderRadius: 6, color: C.blue, cursor: "pointer", padding: "12px", fontSize: 11, fontFamily: "monospace", fontWeight: 700, letterSpacing: 1 }}>
                {phase === "outbound" ? "▶ TURNING INBOUND" : "✓ FIX OVERHEAD"}
              </button>
              <button onClick={() => { cancelAnimationFrame(rafRef.current); setPhase("idle"); setElapsed(0); }}
                style={{ background: C.redDim, border: `1px solid ${C.red}`, borderRadius: 6, color: C.red, cursor: "pointer", padding: "12px 14px", fontSize: 11, fontFamily: "monospace" }}>
                RST
              </button>
            </>
        }
      </div>
    </Card>
  );
}

// ─── Approach Brief Tab ───────────────────────────────────────────────────────
function ApproachBriefTab({ windCalc, sectorEntryFromCalc }) {
  const TYPES = ["NDB", "RNP", "ILS", "VOR"];
  const [b, setB] = useState(() => {
    try { return JSON.parse(localStorage.getItem("holdmaster_brief") || "{}"); }
    catch { return {}; }
  });
  const [copied, setCopied]   = useState(false);
  const [preview, setPreview] = useState(false);
  const [atisRaw, setAtisRaw]   = useState("");
  const [atisParsed, setAtisParsed] = useState(null);
  const [atisExpanded, setAtisExpanded] = useState(false);

  // Listen for plate ingestion events from PlatesTab
  useEffect(() => {
    const handler = (e) => {
      const plate = e.detail;
      if (!plate) return;
      setB(prev => {
        const merged = { ...prev, ...plate };
        try { localStorage.setItem("holdmaster_brief", JSON.stringify(merged)); } catch {}
        return merged;
      });
    };
    window.addEventListener("plate-ingested", handler);
    return () => window.removeEventListener("plate-ingested", handler);
  }, []);

  // Parse ATIS whenever raw text changes
  useEffect(() => {
    if (atisRaw.trim().length > 10) {
      setAtisParsed(parseATIS(atisRaw));
    } else {
      setAtisParsed(null);
    }
  }, [atisRaw]);

  const set = (key, val) => setB(prev => {
    const next = { ...prev, [key]: val };
    try { localStorage.setItem("holdmaster_brief", JSON.stringify(next)); } catch {}
    return next;
  });

  const setFreq = (i, field, val) => {
    const freqs = [...(b.freqs || [{ label: "", freq: "" }])];
    freqs[i] = { ...freqs[i], [field]: val };
    set("freqs", freqs);
  };
  const addFreq = () => set("freqs", [...(b.freqs || []), { label: "", freq: "" }]);
  const delFreq = (i) => { const f = [...(b.freqs || [])]; f.splice(i, 1); set("freqs", f); };

  const setCheckHeight = (i, field, val) => {
    const ch = [...(b.checkHeights || [{ alt: "", dist: "", fix: "", dme: "" }])];
    ch[i] = { ...ch[i], [field]: val };
    set("checkHeights", ch);
  };
  const addCH = () => set("checkHeights", [...(b.checkHeights || []), { alt: "", dist: "", fix: "", dme: "" }]);
  const delCH = (i) => { const c = [...(b.checkHeights || [])]; c.splice(i, 1); set("checkHeights", c); };

  const type = b.approachType || "NDB";

  // Auto-derive sector entry if hold params match
  const inb     = parseInt(b.holdInbound) || null;
  const acH     = parseInt(b.acHdgAtFix) || null;
  const tDir    = b.holdTurnDir || "L";
  const se      = (inb !== null && acH !== null) ? getSectorEntry(acH, inb, tDir) : sectorEntryFromCalc;

  const briefText = generateBrief(b, se, windCalc);

  const copy = () => {
    navigator.clipboard?.writeText(briefText).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const F = { flex: 1, display: "flex", flexDirection: "column" };
  const Row = ({ children }) => <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>{children}</div>;

  const sectionStyle = { background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "10px 12px", marginBottom: 8 };
  const sectionTitle = { fontSize: 8, letterSpacing: 2, color: C.textMuted, textTransform: "uppercase", marginBottom: 8, fontFamily: "monospace" };

  return (
    <div>
      {/* Approach type selector */}
      <Card>
        <CardTitle icon="◈">APPROACH TYPE</CardTitle>
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {TYPES.map(t => (
            <button key={t} onClick={() => set("approachType", t)}
              style={{ flex: 1, padding: "10px 4px", background: type === t ? C.accentDim : C.bg, border: `1px solid ${type === t ? C.accent : C.border}`, borderRadius: 6, color: type === t ? C.accent : C.textSub, cursor: "pointer", fontSize: 12, fontFamily: "monospace", fontWeight: type === t ? 700 : 400 }}>
              {t}
            </button>
          ))}
        </div>
        <Row>
          <div style={F}><Label>ICAO</Label><Input type="text" value={b.icao || ""} onChange={e => set("icao", e.target.value.toUpperCase())} placeholder="YMDG" /></div>
          <div style={F}><Label>Aerodrome Name</Label><Input type="text" value={b.aeroName || ""} onChange={e => set("aeroName", e.target.value)} placeholder="Mudgee" /></div>
        </Row>
        <Row>
          <div style={F}><Label>Runway</Label><Input type="text" value={b.runway || ""} onChange={e => set("runway", e.target.value.toUpperCase())} placeholder="22" /></div>
          <div style={F}><Label>Chart Date</Label><Input type="text" value={b.chartDate || ""} onChange={e => set("chartDate", e.target.value)} placeholder="04 SEP 2025" /></div>
        </Row>
      </Card>

      {/* Frequencies */}
      <Card>
        <CardTitle icon="◈">FREQUENCIES</CardTitle>
        {(b.freqs || [{ label: "", freq: "" }]).map((f, i) => (
          <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}><Label>Label</Label><Input type="text" value={f.label} onChange={e => setFreq(i, "label", e.target.value.toUpperCase())} placeholder="CTAF" /></div>
            <div style={{ flex: 1 }}><Label>Frequency</Label><Input type="text" value={f.freq} onChange={e => setFreq(i, "freq", e.target.value)} placeholder="126.7" /></div>
            <button onClick={() => delFreq(i)} style={{ background: C.redDim, border: `1px solid ${C.red}`, borderRadius: 6, color: C.red, cursor: "pointer", padding: "10px 12px", fontFamily: "monospace", flexShrink: 0, alignSelf: "flex-end", marginBottom: 0 }}>✕</button>
          </div>
        ))}
        <button onClick={addFreq} style={{ background: C.surfaceRaise, border: `1px solid ${C.border}`, borderRadius: 6, color: C.textSub, cursor: "pointer", padding: "8px 14px", fontSize: 11, fontFamily: "monospace", width: "100%" }}>+ ADD FREQUENCY</button>
      </Card>

      {/* Navaid */}
      <Card>
        <CardTitle icon="◈">NAVAID</CardTitle>
        {type === "NDB" && (
          <Row>
            <div style={F}><Label>NDB Frequency</Label><Input type="text" value={b.ndbFreq || ""} onChange={e => set("ndbFreq", e.target.value)} placeholder="398" /></div>
            <div style={F}><Label>NDB Ident</Label><Input type="text" value={b.ndbIdent || ""} onChange={e => set("ndbIdent", e.target.value.toUpperCase())} placeholder="MDG" /></div>
          </Row>
        )}
        {type === "ILS" && (
          <Row>
            <div style={F}><Label>ILS Frequency</Label><Input type="text" value={b.ilsFreq || ""} onChange={e => set("ilsFreq", e.target.value)} placeholder="109.9" /></div>
            <div style={F}><Label>ILS Ident</Label><Input type="text" value={b.ilsIdent || ""} onChange={e => set("ilsIdent", e.target.value.toUpperCase())} placeholder="ITW" /></div>
          </Row>
        )}
        {type === "VOR" && (
          <Row>
            <div style={F}><Label>VOR Frequency</Label><Input type="text" value={b.vorFreq || ""} onChange={e => set("vorFreq", e.target.value)} placeholder="116.0" /></div>
            <div style={F}><Label>VOR Ident</Label><Input type="text" value={b.vorIdent || ""} onChange={e => set("vorIdent", e.target.value.toUpperCase())} placeholder="TW" /></div>
          </Row>
        )}
        {type === "RNP" && (
          <div style={{ fontSize: 11, color: C.green, padding: "8px 0" }}>
            ✓ RNP approach — GNSS programmed and cross-checked statement will be included.
          </div>
        )}
        <Row>
          <div style={F}><Label>MSA Distance (NM)</Label><Input type="text" value={b.msaDist || ""} onChange={e => set("msaDist", e.target.value)} placeholder="10" /></div>
          <div style={F}><Label>MSA (ft)</Label><Input value={b.msa || ""} onChange={e => set("msa", e.target.value)} placeholder="4500" /></div>
        </Row>
        <Row>
          <div style={F}><Label>Aerodrome Elevation (ft)</Label><Input value={b.aeroElev || ""} onChange={e => set("aeroElev", e.target.value)} placeholder="1545" /></div>
        </Row>
      </Card>

      {/* Sector Entry */}
      <Card>
        <CardTitle icon="◈">SECTOR ENTRY</CardTitle>
        <Row>
          <div style={F}><Label>AC Heading at Fix (°M)</Label><Input value={b.acHdgAtFix || ""} onChange={e => set("acHdgAtFix", e.target.value)} placeholder="203" /></div>
          <div style={F}><Label>Approach Desc (opt)</Label><Input type="text" value={b.approachDesc || ""} onChange={e => set("approachDesc", e.target.value)} placeholder="I will be flying in at…" /></div>
        </Row>
        {type === "RNP" && (
          <div style={{ marginBottom: 10 }}>
            <Label>IAF Fix</Label>
            <Input type="text" value={b.iafFix || ""} onChange={e => set("iafFix", e.target.value.toUpperCase())} placeholder="DBOWD" />
          </div>
        )}
        {type === "ILS" && (
          <Row>
            <div style={F}><Label>IAF Fix</Label><Input type="text" value={b.iafFix || ""} onChange={e => set("iafFix", e.target.value.toUpperCase())} placeholder="VETAK" /></div>
            <div style={F}><Label>IAF DME</Label><Input type="text" value={b.iafDme || ""} onChange={e => set("iafDme", e.target.value)} placeholder="13.5 ITW DME" /></div>
          </Row>
        )}
        {se && (
          <div style={{ background: se.bgColor, border: `1px solid ${se.borderColor}`, borderRadius: 6, padding: "8px 12px", marginTop: 6 }}>
            <Pill color={se.color}>{se.badge}</Pill>
            <div style={{ fontSize: 10, color: C.textSub, marginTop: 6 }}>Auto-derived from heading inputs above.</div>
          </div>
        )}
        {/* Outbound timing */}
        <Divider label="OUTBOUND TIMING" />
        <Row>
          <div style={F}><Label>TW (sec)</Label><Input value={b.twSecs || ""} onChange={e => set("twSecs", e.target.value)} placeholder="5" /></div>
          <div style={F}><Label>Nil Wind (sec)</Label><Input value={b.nilSecs || ""} onChange={e => set("nilSecs", e.target.value)} placeholder="15" /></div>
          <div style={F}><Label>HW (sec)</Label><Input value={b.hwSecs || ""} onChange={e => set("hwSecs", e.target.value)} placeholder="20" /></div>
        </Row>
        {type === "NDB" && se?.sector === 2 && (
          <div>
            <Label>S2 Outbound Time (written)</Label>
            <Input type="text" value={b.s2OutboundTime || ""} onChange={e => set("s2OutboundTime", e.target.value)} placeholder="1 minute 15 seconds" />
          </div>
        )}
      </Card>

      {/* Hold Parameters */}
      <Card>
        <CardTitle icon="◈">HOLDING PATTERN</CardTitle>
        <Row>
          <div style={F}><Label>Hold Fix Name</Label><Input type="text" value={b.holdFix || ""} onChange={e => set("holdFix", e.target.value.toUpperCase())} placeholder="MDG" /></div>
          <div style={F}><Label>Inbound Track (°M)</Label><Input value={b.holdInbound || ""} onChange={e => set("holdInbound", e.target.value)} placeholder="009" /></div>
        </Row>
        <Row>
          <div style={F}>
            <Label>Turn Direction</Label>
            <div style={{ display: "flex", gap: 6 }}>
              <SegBtn active={tDir === "R"} onClick={() => set("holdTurnDir", "R")}>RIGHT (STD)</SegBtn>
              <SegBtn active={tDir === "L"} onClick={() => set("holdTurnDir", "L")}>LEFT (NON-STD)</SegBtn>
            </div>
          </div>
        </Row>
        <Row>
          <div style={F}><Label>Min Hold Alt (ft)</Label><Input value={b.holdAlt || ""} onChange={e => set("holdAlt", e.target.value)} placeholder="4500" /></div>
          <div style={F}><Label>Hold Leg Time</Label><Input type="text" value={b.holdLeg || ""} onChange={e => set("holdLeg", e.target.value)} placeholder="1 minute" /></div>
        </Row>
      </Card>

      {/* Procedure / Descent */}
      <Card>
        <CardTitle icon="◈">PROCEDURE & DESCENT</CardTitle>

        {(type === "NDB" || type === "VOR") && (
          <>
            <Row>
              <div style={F}><Label>Outbound Track (°M)</Label><Input value={b.outboundTrack || ""} onChange={e => set("outboundTrack", e.target.value)} placeholder="189" /></div>
              <div style={F}><Label>Outbound Time (min)</Label><Input type="text" value={b.outboundTime || ""} onChange={e => set("outboundTime", e.target.value)} placeholder="3.5" /></div>
            </Row>
            {type === "VOR" && (
              <div style={{ marginBottom: 10 }}>
                <Label>Cat Note (e.g. Cat A/B)</Label>
                <Input type="text" value={b.catNote || ""} onChange={e => set("catNote", e.target.value)} placeholder="Cat A/B" />
              </div>
            )}
            <Row>
              <div style={F}><Label>Descent From (ft)</Label><Input value={b.descentFrom || ""} onChange={e => set("descentFrom", e.target.value)} placeholder="5000" /></div>
              <div style={F}><Label>Descent To (ft)</Label><Input value={b.descentTo || ""} onChange={e => set("descentTo", e.target.value)} placeholder="3700" /></div>
            </Row>
            <Row>
              <div style={F}><Label>Final Turn Direction</Label>
                <div style={{ display: "flex", gap: 6 }}>
                  <SegBtn active={b.finalTurnDir === "right" || !b.finalTurnDir} onClick={() => set("finalTurnDir", "right")}>RIGHT</SegBtn>
                  <SegBtn active={b.finalTurnDir === "left"} onClick={() => set("finalTurnDir", "left")}>LEFT</SegBtn>
                </div>
              </div>
              <div style={F}><Label>Final Inbound (°M)</Label><Input value={b.finalInbound || ""} onChange={e => set("finalInbound", e.target.value)} placeholder="209" /></div>
            </Row>
          </>
        )}

        {type === "RNP" && (
          <>
            <Row>
              <div style={F}><Label>Transition Track (°M)</Label><Input value={b.transitionTrack || ""} onChange={e => set("transitionTrack", e.target.value)} placeholder="333" /></div>
              <div style={F}><Label>Transition Dist (NM)</Label><Input value={b.transitionNM || ""} onChange={e => set("transitionNM", e.target.value)} placeholder="5" /></div>
            </Row>
            <Row>
              <div style={F}><Label>IF Fix</Label><Input type="text" value={b.ifFix || ""} onChange={e => set("ifFix", e.target.value.toUpperCase())} placeholder="DBOWI" /></div>
              <div style={F}><Label>FAF Fix</Label><Input type="text" value={b.fafFix || ""} onChange={e => set("fafFix", e.target.value.toUpperCase())} placeholder="DBOWF" /></div>
            </Row>
            <Row>
              <div style={F}><Label>Descent From (ft)</Label><Input value={b.descentFrom || ""} onChange={e => set("descentFrom", e.target.value)} placeholder="5000" /></div>
              <div style={F}><Label>Descent To (ft)</Label><Input value={b.descentTo || ""} onChange={e => set("descentTo", e.target.value)} placeholder="4100" /></div>
            </Row>
            <Row>
              <div style={F}><Label>Final Turn Dir</Label>
                <div style={{ display: "flex", gap: 6 }}>
                  <SegBtn active={b.finalTurnDir === "right" || !b.finalTurnDir} onClick={() => set("finalTurnDir", "right")}>RIGHT</SegBtn>
                  <SegBtn active={b.finalTurnDir === "left"} onClick={() => set("finalTurnDir", "left")}>LEFT</SegBtn>
                </div>
              </div>
              <div style={F}><Label>Final Inbound (°M)</Label><Input value={b.finalInbound || ""} onChange={e => set("finalInbound", e.target.value)} placeholder="043" /></div>
            </Row>
            <Row>
              <div style={F}><Label>Gear Dist prior FAF (NM)</Label><Input type="text" value={b.gearDist || ""} onChange={e => set("gearDist", e.target.value)} placeholder="0.5" /></div>
              <div style={F}><Label>Power Config</Label><Input type="text" value={b.powerConfig || ""} onChange={e => set("powerConfig", e.target.value)} placeholder="16'' / 2300 RPM" /></div>
            </Row>
            <Row>
              <div style={F}><Label>Descent Angle (°)</Label><Input type="text" value={b.descentAngle || ""} onChange={e => set("descentAngle", e.target.value)} placeholder="3" /></div>
            </Row>
          </>
        )}

        {type === "ILS" && (
          <>
            <Row>
              <div style={F}><Label>Power Config</Label><Input type="text" value={b.powerConfig || ""} onChange={e => set("powerConfig", e.target.value)} placeholder="16'' / 2300 RPM" /></div>
            </Row>
            <div style={{ marginBottom: 10 }}>
              <Label>G/S Fail Action (opt)</Label>
              <Input type="text" value={b.gsFail || ""} onChange={e => set("gsFail", e.target.value)} placeholder="continue with localiser using check-heights" />
            </div>
            <div style={{ marginBottom: 10 }}>
              <Label>LOC Fail Action (opt)</Label>
              <Input type="text" value={b.locFail || ""} onChange={e => set("locFail", e.target.value)} placeholder="go missed and carry out the VOR approach" />
            </div>
          </>
        )}

        {type === "VOR" && (
          <>
            <div style={{ marginBottom: 10 }}>
              <Label>Stabilised Note (opt)</Label>
              <Input type="text" value={b.stabilisedNote || ""} onChange={e => set("stabilisedNote", e.target.value)} placeholder="Once stabilised inbound, gears down, set 16'' / 2300 RPM..." />
            </div>
            <div style={{ marginBottom: 10 }}>
              <Label>VOR Fail Action (opt)</Label>
              <Input type="text" value={b.vorFail || ""} onChange={e => set("vorFail", e.target.value)} placeholder="If the VOR fails, we will conduct a missed approach..." />
            </div>
          </>
        )}
      </Card>

      {/* Check Heights */}
      {(type === "RNP" || type === "ILS") && (
        <Card>
          <CardTitle icon="◈">CHECK HEIGHTS</CardTitle>
          {(b.checkHeights || [{ alt: "", dist: "", fix: "", dme: "" }]).map((ch, i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "flex-end" }}>
              {type === "ILS" && <div style={{ flex: 1 }}><Label>Fix</Label><Input type="text" value={ch.fix || ""} onChange={e => setCheckHeight(i, "fix", e.target.value.toUpperCase())} placeholder="VEBMI" /></div>}
              {type === "ILS" && <div style={{ flex: 1 }}><Label>DME</Label><Input type="text" value={ch.dme || ""} onChange={e => setCheckHeight(i, "dme", e.target.value)} placeholder="5.5NM ITW" /></div>}
              {type === "RNP" && <div style={{ flex: 1 }}><Label>Dist (NM)</Label><Input type="text" value={ch.dist || ""} onChange={e => setCheckHeight(i, "dist", e.target.value)} placeholder="4" /></div>}
              <div style={{ flex: 1 }}><Label>Alt (ft)</Label><Input value={ch.alt || ""} onChange={e => setCheckHeight(i, "alt", e.target.value)} placeholder="2660" /></div>
              <button onClick={() => delCH(i)} style={{ background: C.redDim, border: `1px solid ${C.red}`, borderRadius: 6, color: C.red, cursor: "pointer", padding: "10px 12px", fontFamily: "monospace", flexShrink: 0, alignSelf: "flex-end" }}>✕</button>
            </div>
          ))}
          <button onClick={addCH} style={{ background: C.surfaceRaise, border: `1px solid ${C.border}`, borderRadius: 6, color: C.textSub, cursor: "pointer", padding: "8px 14px", fontSize: 11, fontFamily: "monospace", width: "100%" }}>+ ADD CHECK HEIGHT</button>
        </Card>
      )}

      {/* Minima */}
      <Card>
        <CardTitle icon="◈">MINIMA</CardTitle>
        {(type === "NDB" || type === "VOR") && (
          <>
            <Row>
              <div style={F}><Label>MDA (ft)</Label><Input value={b.mda || ""} onChange={e => set("mda", e.target.value)} placeholder="3110" /></div>
              <div style={F}><Label>MDA AGL (ft, NDB)</Label><Input value={b.mdaAgl || ""} onChange={e => set("mdaAgl", e.target.value)} placeholder="1565" /></div>
            </Row>
            {type === "VOR" && (
              <div style={{ marginBottom: 10 }}>
                <Label>MDA with ATIS (ft)</Label>
                <Input value={b.mdaAtis || ""} onChange={e => set("mdaAtis", e.target.value)} placeholder="2070" />
              </div>
            )}
            <Row>
              <div style={F}><Label>Visibility (km)</Label><Input type="text" value={b.visibility || ""} onChange={e => set("visibility", e.target.value)} placeholder="5.0" /></div>
            </Row>
            {type === "NDB" && (
              <Row>
                <div style={F}><Label>Circling MDA (ft)</Label><Input value={b.circlingMda || ""} onChange={e => set("circlingMda", e.target.value)} placeholder="3150" /></div>
                <div style={F}><Label>Circling Vis (km)</Label><Input type="text" value={b.circlingVis || ""} onChange={e => set("circlingVis", e.target.value)} placeholder="2.4" /></div>
              </Row>
            )}
          </>
        )}
        {type === "RNP" && (
          <>
            <Row>
              <div style={F}><Label>LNAV MDA (ft)</Label><Input value={b.lnavMda || ""} onChange={e => set("lnavMda", e.target.value)} placeholder="1530" /></div>
              <div style={F}><Label>LNAV MDA w/ ATIS (ft)</Label><Input value={b.lnavMdaAtis || ""} onChange={e => set("lnavMdaAtis", e.target.value)} placeholder="1430" /></div>
            </Row>
            <Row>
              <div style={F}><Label>LNAV Vis (km)</Label><Input type="text" value={b.lnavVis || ""} onChange={e => set("lnavVis", e.target.value)} placeholder="3.4" /></div>
              <div style={F}><Label>ATIS Note</Label><Input type="text" value={b.atisNote || ""} onChange={e => set("atisNote", e.target.value)} placeholder="ATIS in this case" /></div>
            </Row>
            <Divider label="LNAV/VNAV (IF APPLICABLE)" />
            <Row>
              <div style={F}><Label>LNAV/VNAV DA (ft)</Label><Input value={b.lnavVnavDa || ""} onChange={e => set("lnavVnavDa", e.target.value)} placeholder="1350" /></div>
              <div style={F}><Label>LNAV/VNAV Vis (km)</Label><Input type="text" value={b.lnavVnavVis || ""} onChange={e => set("lnavVnavVis", e.target.value)} placeholder="2.3" /></div>
            </Row>
            <div style={{ marginBottom: 0 }}>
              <Label>LNAV/VNAV Note (opt)</Label>
              <Input type="text" value={b.lnavVnavNote || ""} onChange={e => set("lnavVnavNote", e.target.value)} placeholder="If LNAV/VNAV is utilised" />
            </div>
          </>
        )}
        {type === "ILS" && (
          <>
            <Row>
              <div style={F}><Label>DA (ft)</Label><Input value={b.da || ""} onChange={e => set("da", e.target.value)} placeholder="1740" /></div>
              <div style={F}><Label>DA AGL (ft)</Label><Input value={b.daAgl || ""} onChange={e => set("daAgl", e.target.value)} placeholder="414" /></div>
            </Row>
            <Row>
              <div style={F}><Label>DA Vis</Label><Input type="text" value={b.daVis || ""} onChange={e => set("daVis", e.target.value)} placeholder="2.4km" /></div>
              <div style={F}><Label>Vis Note (opt)</Label><Input type="text" value={b.daVisNote || ""} onChange={e => set("daVisNote", e.target.value)} placeholder="/ 1.8km with actual QNH" /></div>
            </Row>
            <Divider label="LOC-ONLY (IF APPLICABLE)" />
            <Row>
              <div style={F}><Label>LOC MDA (ft)</Label><Input value={b.locOnlyMda || ""} onChange={e => set("locOnlyMda", e.target.value)} placeholder="1990" /></div>
              <div style={F}><Label>LOC AGL (ft)</Label><Input value={b.locOnlyAgl || ""} onChange={e => set("locOnlyAgl", e.target.value)} placeholder="664" /></div>
            </Row>
            <div style={{ marginBottom: 0 }}>
              <Label>LOC Vis (km)</Label>
              <Input type="text" value={b.locOnlyVis || ""} onChange={e => set("locOnlyVis", e.target.value)} placeholder="3.8" />
            </div>
          </>
        )}
      </Card>

      {/* Alternate */}
      <Card>
        <CardTitle icon="◈">ALTERNATE</CardTitle>
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          <SegBtn active={!b.alternateReqd || b.alternateReqd === "no"} onClick={() => set("alternateReqd", "no")}>NOT REQUIRED</SegBtn>
          <SegBtn active={b.alternateReqd === "yes"} onClick={() => set("alternateReqd", "yes")}>REQUIRED</SegBtn>
        </div>
        <div>
          <Label>{b.alternateReqd === "yes" ? "Alternate Destination" : "Reason Not Required"}</Label>
          <Input type="text" value={b.alternateReason || ""} onChange={e => set("alternateReason", e.target.value)}
            placeholder={b.alternateReqd === "yes" ? "YMML" : "fuel / weather margins"} />
        </div>
        {b.alternateReqd === "yes" && (
          <div style={{ marginTop: 8 }}>
            <Label>Alternate Dest ICAO</Label>
            <Input type="text" value={b.alternateDest || ""} onChange={e => set("alternateDest", e.target.value.toUpperCase())} placeholder="YMML" />
          </div>
        )}
      </Card>

      {/* Missed Approach */}
      <Card>
        <CardTitle icon="◈">MISSED APPROACH</CardTitle>
        <Row>
          <div style={F}><Label>Initial Turn</Label>
            <div style={{ display: "flex", gap: 6 }}>
              <SegBtn active={b.missedTurn !== "left"} onClick={() => set("missedTurn", "right")}>RIGHT</SegBtn>
              <SegBtn active={b.missedTurn === "left"} onClick={() => set("missedTurn", "left")}>LEFT</SegBtn>
            </div>
          </div>
          <div style={F}><Label>Track (°M)</Label><Input value={b.missedTrack || ""} onChange={e => set("missedTrack", e.target.value)} placeholder="300" /></div>
        </Row>
        <Row>
          <div style={F}><Label>Climb to (ft)</Label><Input value={b.missedAlt || ""} onChange={e => set("missedAlt", e.target.value)} placeholder="4100" /></div>
          {type === "RNP" && <div style={F}><Label>Missed Fix (DCT to)</Label><Input type="text" value={b.missedFix || ""} onChange={e => set("missedFix", e.target.value.toUpperCase())} placeholder="DBOWH" /></div>}
        </Row>
        <div style={{ marginBottom: 0 }}>
          <Label>Additional Detail (opt)</Label>
          <Input type="text" value={b.missedDetail || ""} onChange={e => set("missedDetail", e.target.value)} placeholder="During TWR hours, proceed as directed by ATC..." />
        </div>
        {type === "ILS" && (
          <div style={{ marginTop: 8 }}>
            <Label>Outside TWR Hours (opt)</Label>
            <Input type="text" value={b.missedOutsideTWR || ""} onChange={e => set("missedOutsideTWR", e.target.value)} placeholder="turn left, track to VOR/DME, climb to 4500ft..." />
          </div>
        )}
      </Card>

      {/* ATIS Decoder */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: atisExpanded ? 12 : 0 }}>
          <CardTitle icon="📡">ATIS DECODER</CardTitle>
          <button
            onClick={() => setAtisExpanded(x => !x)}
            style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 5, color: C.textSub, cursor: "pointer", padding: "4px 10px", fontSize: 9, fontFamily: "monospace", letterSpacing: 1.5, marginBottom: 12 }}>
            {atisExpanded ? "HIDE" : "EXPAND"}
          </button>
        </div>

        {atisExpanded && (
          <>
            <div style={{ fontSize: 10, color: C.textSub, marginBottom: 8, lineHeight: 1.7 }}>
              Paste raw ATIS string. Wind auto-fills, ceiling/vis checked against your minima.
            </div>
            <textarea
              value={atisRaw}
              onChange={e => setAtisRaw(e.target.value)}
              placeholder={"YMML INFO GOLF 281750 WIND 280/12 VIS 8KM FEW030 SCT050 TEMP 14 DEW 09 QNH 1013 RWY 27"}
              style={{ width: "100%", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, padding: "10px 12px", fontSize: 12, fontFamily: "monospace", boxSizing: "border-box", outline: "none", resize: "vertical", minHeight: 80, lineHeight: 1.6 }}
              onFocus={e => (e.target.style.borderColor = C.accent)}
              onBlur={e => (e.target.style.borderColor = C.border)}
            />

            {atisParsed && (
              <div style={{ marginTop: 10 }}>
                {/* Minima check banner */}
                {(() => {
                  const minima = b.da || b.mda || b.lnavMda;
                  const vis    = b.daVis || b.visibility || b.lnavVis;
                  const check  = minima ? atisMinimaClear(atisParsed, minima, vis) : null;
                  const bannerColor = check === "go" ? C.green : check === "no-go" ? C.red : check === "marginal" ? C.s2 : null;
                  const bannerBg    = check === "go" ? C.greenDim : check === "no-go" ? C.redDim : check === "marginal" ? "#2A1A00" : null;
                  const bannerText  = check === "go" ? "✓ ABOVE MINIMA — CONDITIONS SUITABLE" : check === "no-go" ? "✗ BELOW MINIMA — CONDITIONS NOT SUITABLE" : check === "marginal" ? "⚠ MARGINAL — CLOSE TO MINIMA" : null;
                  return bannerColor ? (
                    <div style={{ background: bannerBg, border: `1px solid ${bannerColor}`, borderRadius: 6, padding: "10px 12px", fontSize: 11, color: bannerColor, fontFamily: "monospace", fontWeight: 700, letterSpacing: 1, marginBottom: 10 }}>
                      {bannerText}
                    </div>
                  ) : null;
                })()}

                {/* Parsed values grid */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 14px", fontFamily: "monospace" }}>
                  {[
                    atisParsed.icao        && ["ICAO",      atisParsed.icao,                           C.accent],
                    atisParsed.info        && ["INFO",       atisParsed.info,                            C.text],
                    atisParsed.windDir !== undefined && ["WIND",
                      atisParsed.windSpd === 0 ? "CALM" : `${String(atisParsed.windDir).padStart(3,"0")}°/${atisParsed.windSpd}kt${atisParsed.gust ? ` G${atisParsed.gust}kt` : ""}`,
                      C.blue],
                    atisParsed.vis         && ["VIS",        atisParsed.cavok ? "CAVOK" : `${atisParsed.vis >= 1000 ? (atisParsed.vis/1000).toFixed(1)+"km" : atisParsed.vis+"m"}`, atisParsed.vis >= 5000 ? C.green : atisParsed.vis >= 1500 ? C.s2 : C.red],
                    atisParsed.ceiling     && ["CEILING",    `${atisParsed.ceiling}ft`,                 atisParsed.ceiling > 2000 ? C.green : atisParsed.ceiling > 1000 ? C.s2 : C.red],
                    atisParsed.temp !== undefined && ["TEMP/DEW", `${atisParsed.temp}°/${atisParsed.dew ?? "?"}°`, C.text],
                    atisParsed.qnh         && ["QNH",        `${atisParsed.qnh} hPa`,                  C.accent],
                    atisParsed.trend       && ["TREND",      atisParsed.trend,                          atisParsed.trend === "NOSIG" ? C.green : C.s2],
                    atisParsed.runways?.length && ["RWY IN USE", atisParsed.runways.join(", "),         C.text],
                  ].filter(Boolean).map(([l, v, c]) => (
                    <div key={l} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ fontSize: 8, color: C.textSub, letterSpacing: 1.5, textTransform: "uppercase" }}>{l}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: c }}>{v}</span>
                    </div>
                  ))}
                </div>

                {/* Cloud layers */}
                {atisParsed.clouds?.length > 0 && (
                  <div style={{ marginTop: 10, fontSize: 10, color: C.textSub, fontFamily: "monospace" }}>
                    {atisParsed.clouds.map((cl, i) => (
                      <span key={i} style={{ marginRight: 10, color: cl.cover === "BKN" || cl.cover === "OVC" ? C.text : C.textSub }}>
                        {cl.cover}{String(cl.alt / 100).padStart(3, "0")}
                      </span>
                    ))}
                  </div>
                )}

                {/* Auto-fill wind button */}
                {atisParsed.windDir !== undefined && atisParsed.windSpd !== undefined && (
                  <div style={{ marginTop: 10, fontSize: 10, color: C.textSub, fontFamily: "monospace" }}>
                    Wind {String(atisParsed.windDir).padStart(3,"0")}°/{atisParsed.windSpd}kt detected.
                    Wind tab auto-fills when you return to HOLD.
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </Card>

      {/* VDP Calculator */}
      {(type === "NDB" || type === "VOR") && (
        <Card>
          <CardTitle icon="◈">VDP — VISUAL DESCENT POINT</CardTitle>
          <div style={{ fontSize: 10, color: C.textSub, marginBottom: 10, lineHeight: 1.6 }}>
            VDP distance from threshold: <strong style={{ color: C.text }}>(MDA − TDZE) ÷ 300</strong><br />
            Then verify: at VDP height = MDA, you should see runway environment.
          </div>
          {b.mda && b.aeroElev && (
            (() => {
              const mda = parseFloat(b.mda);
              const tdze = parseFloat(b.aeroElev);
              const tasKt = parseFloat(b.vdpTas || "90");
              const vdpDist = ((mda - tdze) / 300).toFixed(2);
              const vdpTimeSecs = Math.round((parseFloat(vdpDist) / tasKt) * 3600);
              return (
                <>
                  <DataRow label="HEIGHT ABOVE TDZE" value={`${Math.round(mda - tdze)}ft`} />
                  <DataRow label="VDP DISTANCE FROM THR" value={`${vdpDist} NM`} valueColor={C.accent} large />
                  <DataRow label="TIME FROM THR @ TAS" value={fmtTime(vdpTimeSecs)} valueColor={C.blue} />
                  <div style={{ marginTop: 10 }}>
                    <Label>TAS for timing (kt)</Label>
                    <Input value={b.vdpTas || ""} onChange={e => set("vdpTas", e.target.value)} placeholder="90" />
                  </div>
                </>
              );
            })()
          )}
          {(!b.mda || !b.aeroElev) && (
            <div style={{ fontSize: 11, color: C.textMuted }}>Enter MDA and Aerodrome Elevation above to compute.</div>
          )}
        </Card>
      )}

      {/* Preview / Copy */}
      <Card style={{ borderColor: C.accent + "44" }}>
        <div style={{ display: "flex", gap: 8, marginBottom: preview ? 12 : 0 }}>
          <button onClick={() => setPreview(p => !p)}
            style={{ flex: 1, background: C.accentDim, border: `1px solid ${C.accent}`, borderRadius: 6, color: C.accent, cursor: "pointer", padding: "12px", fontSize: 11, fontFamily: "monospace", fontWeight: 700, letterSpacing: 1.5 }}>
            {preview ? "HIDE BRIEF" : "PREVIEW BRIEF"}
          </button>
          <button onClick={copy}
            style={{ background: C.greenDim, border: `1px solid ${C.green}`, borderRadius: 6, color: C.green, cursor: "pointer", padding: "12px 16px", fontSize: 11, fontFamily: "monospace", fontWeight: 700 }}>
            {copied ? "✓ COPIED" : "COPY"}
          </button>
        </div>
        {preview && (
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "14px", fontSize: 11, color: C.text, lineHeight: 2, fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {briefText}
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Plates Tab (AI Plate Ingestion) ──────────────────────────────────────────
function PlatesTab({ onPopulateBrief }) {
  const [status, setStatus]   = useState("idle"); // idle|loading|done|error
  const [result, setResult]   = useState(null);
  const [error, setError]     = useState("");
  const [library, setLibrary] = useState(() => {
    try { return JSON.parse(localStorage.getItem("holdmaster_plates") || "[]"); }
    catch { return []; }
  });
  const [preview, setPreview] = useState(null);
  const [libSearch, setLibSearch] = useState("");
  const fileRef = useRef(null);

  const saveLibrary = (lib) => {
    setLibrary(lib);
    try { localStorage.setItem("holdmaster_plates", JSON.stringify(lib)); } catch {}
  };

  const SYSTEM_PROMPT = `You are an expert Australian IFR approach plate reader. Extract ALL approach data from this Airservices Australia plate image or PDF page. Return ONLY valid JSON, no markdown, no explanation.

Required JSON structure:
{
  "icao": "YMML",
  "aeroName": "Melbourne",
  "aeroElev": 434,
  "runway": "27",
  "approachType": "ILS",
  "chartDate": "15 JUN 2023",
  "msa": 3000,
  "msaDist": 10,
  "freqs": [
    {"label": "ATIS", "freq": "118.5"},
    {"label": "TWR", "freq": "120.5"}
  ],
  "ndbFreq": null, "ndbIdent": null,
  "ilsFreq": "110.9", "ilsIdent": "IMML",
  "vorFreq": null, "vorIdent": null,
  "rnp": false,
  "iafFix": "TESAT",
  "ifFix": null,
  "fafFix": "BUNDU",
  "holdFix": "TESAT",
  "holdInbound": 270,
  "holdTurnDir": "R",
  "holdAlt": 3000,
  "holdLeg": "1 minute",
  "outboundTrack": null,
  "outboundTime": null,
  "transitionTrack": null,
  "transitionNM": null,
  "descentFrom": 4000,
  "descentTo": 3000,
  "finalInbound": 270,
  "finalTurnDir": "right",
  "gearDist": "0.5",
  "powerConfig": null,
  "descentAngle": 3,
  "checkHeights": [
    {"fix": "BUNDU", "dme": "5.0NM", "dist": null, "alt": 2500}
  ],
  "da": 1200, "daAgl": 200, "daVis": "2.4",
  "daVisNote": null,
  "locOnlyMda": null, "locOnlyAgl": null, "locOnlyVis": null,
  "lnavMda": null, "lnavMdaAtis": null, "lnavVis": null,
  "lnavVnavDa": null, "lnavVnavVis": null,
  "mda": null, "mdaAgl": null,
  "visibility": null,
  "circlingMda": null, "circlingVis": null,
  "missedTurn": "left",
  "missedTrack": 270,
  "missedAlt": 3000,
  "missedFix": null,
  "missedDetail": null,
  "alternateReqd": "no",
  "gsFail": "continue localiser approach using check heights",
  "locFail": "go missed and attempt alternate approach"
}

Rules:
- Extract EXACTLY what is printed on the plate. Do not guess or invent values.
- If a field is not on this plate, set it to null.
- approachType must be one of: NDB, RNP, ILS, VOR
- holdTurnDir: "R" for right, "L" for left
- All altitudes in feet, all tracks/headings in degrees magnetic
- freqs: include ALL frequencies shown (ATIS, AWIS, TWR, APP, CTAF, PAL, CEN, SMC, etc)
- chartDate: format as printed on the plate
- For RNP approaches, set rnp: true
- missedTurn: "right" or "left"
- descentAngle: the glidepath angle (e.g. 3.0 for 3 degrees)`;

  const ingestFile = async (file) => {
    if (!file) return;
    setStatus("loading");
    setError("");
    setResult(null);

    try {
      // Convert file to base64
      const base64 = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result.split(",")[1]);
        reader.onerror = () => rej(new Error("File read failed"));
        reader.readAsDataURL(file);
      });

      const isImage = file.type.startsWith("image/");
      const mediaType = isImage ? file.type : "application/pdf";

      // Call Claude API with vision
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 2000,
          system: SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: [
              {
                type: isImage ? "image" : "document",
                source: { type: "base64", media_type: mediaType, data: base64 }
              },
              {
                type: "text",
                text: "Extract all approach data from this plate and return as JSON only."
              }
            ]
          }]
        })
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error?.message || `API error ${response.status}`);
      }

      const data = await response.json();
      const raw = data.content?.find(b => b.type === "text")?.text || "";

      // Strip any markdown fences
      const clean = raw.replace(/```[a-z]*/g, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(clean);

      // Add metadata
      parsed._fileName = file.name;
      parsed._ingestedAt = new Date().toISOString();
      parsed._id = `${parsed.icao || "UNK"}_${parsed.approachType || "UNK"}_${Date.now()}`;

      setResult(parsed);
      setStatus("done");

      // Add to library
      const newLib = [parsed, ...library.filter(p => p._id !== parsed._id)].slice(0, 50);
      saveLibrary(newLib);

    } catch (err) {
      setStatus("error");
      setError(err.message || "Unknown error");
    }
  };

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (file) ingestFile(file);
    e.target.value = "";
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) ingestFile(file);
  };

  const loadPlate = (plate) => {
    onPopulateBrief(plate);
  };

  const deletePlate = (id) => {
    const newLib = library.filter(p => p._id !== id);
    saveLibrary(newLib);
    if (preview?._id === id) setPreview(null);
  };

  const filteredLib = library.filter(p =>
    !libSearch ||
    (p.icao || "").toLowerCase().includes(libSearch.toLowerCase()) ||
    (p.aeroName || "").toLowerCase().includes(libSearch.toLowerCase()) ||
    (p.approachType || "").toLowerCase().includes(libSearch.toLowerCase())
  );

  const typeColor = (t) => t === "ILS" ? C.blue : t === "RNP" ? C.purple : t === "NDB" ? C.s2 : C.green;

  return (
    <div>
      {/* Upload zone */}
      <Card>
        <CardTitle icon="◈">PLATE INGESTION</CardTitle>
        <div style={{ fontSize: 10, color: C.textSub, marginBottom: 12, lineHeight: 1.7 }}>
          Upload any Airservices Australia approach plate — photo, scan, or PDF.
          Claude reads it and auto-fills the Approach Brief for you.
        </div>

        {/* Drop zone */}
        <div
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
          onClick={() => status !== "loading" && fileRef.current?.click()}
          style={{
            border: `2px dashed ${status === "loading" ? C.accent : status === "done" ? C.green : status === "error" ? C.red : C.border}`,
            borderRadius: 10, padding: "28px 16px", textAlign: "center",
            cursor: status === "loading" ? "default" : "pointer",
            background: status === "loading" ? C.accentGlow : C.bg,
            transition: "all 0.2s", marginBottom: 10,
          }}
        >
          {status === "idle" && (
            <>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📄</div>
              <div style={{ fontSize: 12, color: C.text, fontFamily: "monospace", marginBottom: 4 }}>
                TAP TO UPLOAD PLATE
              </div>
              <div style={{ fontSize: 10, color: C.textSub }}>
                PDF · JPG · PNG · HEIC · any image format
              </div>
            </>
          )}
          {status === "loading" && (
            <>
              <div style={{ fontSize: 22, marginBottom: 8, animation: "spin 1s linear infinite" }}>⟳</div>
              <div style={{ fontSize: 12, color: C.accent, fontFamily: "monospace" }}>
                READING PLATE...
              </div>
              <div style={{ fontSize: 10, color: C.textSub, marginTop: 4 }}>
                Claude is extracting all approach data
              </div>
            </>
          )}
          {status === "done" && result && (
            <>
              <div style={{ fontSize: 22, marginBottom: 6 }}>✓</div>
              <div style={{ fontSize: 13, color: C.green, fontFamily: "monospace", fontWeight: 700 }}>
                {result.icao} {result.approachType} RWY {result.runway}
              </div>
              <div style={{ fontSize: 10, color: C.textSub, marginTop: 4 }}>
                Tap to upload another plate
              </div>
            </>
          )}
          {status === "error" && (
            <>
              <div style={{ fontSize: 22, marginBottom: 6 }}>⚠</div>
              <div style={{ fontSize: 11, color: C.red, fontFamily: "monospace", marginBottom: 4 }}>
                INGESTION FAILED
              </div>
              <div style={{ fontSize: 10, color: C.textSub }}>{error}</div>
              <div style={{ fontSize: 10, color: C.textSub, marginTop: 4 }}>Tap to try again</div>
            </>
          )}
        </div>

        <input ref={fileRef} type="file"
          accept="image/*,.pdf,application/pdf"
          onChange={handleFile}
          style={{ display: "none" }} />

        {/* Load to Brief button */}
        {status === "done" && result && (
          <button
            onClick={() => loadPlate(result)}
            style={{ width: "100%", background: C.accentDim, border: `1px solid ${C.accent}`, borderRadius: 8, color: C.accent, cursor: "pointer", padding: "14px", fontSize: 12, fontFamily: "monospace", fontWeight: 700, letterSpacing: 1.5, marginBottom: 8 }}
          >
            LOAD INTO APPROACH BRIEF →
          </button>
        )}

        {/* Extracted data preview */}
        {status === "done" && result && (
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "12px", fontSize: 10, fontFamily: "monospace", lineHeight: 2 }}>
            <div style={{ color: C.textSub, letterSpacing: 1.5, marginBottom: 6, fontSize: 9 }}>EXTRACTED DATA</div>
            {[
              ["APPROACH",  `${result.approachType} RWY ${result.runway || "?"}`],
              ["CHART DATE", result.chartDate || "—"],
              ["MSA",        result.msa ? `${result.msa}ft / ${result.msaDist || 10}NM` : "—"],
              ["ELEVATION",  result.aeroElev ? `${result.aeroElev}ft` : "—"],
              ["HOLD FIX",   result.holdFix || "—"],
              ["INBOUND",    result.holdInbound ? `${result.holdInbound}°M ${result.holdTurnDir === "L" ? "L/H" : "R/H"}` : "—"],
              ["HOLD ALT",   result.holdAlt ? `${result.holdAlt}ft` : "—"],
              ["MINIMA",     result.da ? `DA ${result.da}ft / ${result.daVis || "?"}km` : result.mda ? `MDA ${result.mda}ft / ${result.visibility || "?"}km` : result.lnavMda ? `LNAV ${result.lnavMda}ft` : "—"],
              ["MISSED",     result.missedTrack ? `${result.missedTurn?.toUpperCase() || "?"} → ${result.missedTrack}° → ${result.missedAlt}ft` : "—"],
              ["FREQS",      result.freqs?.length ? `${result.freqs.length} frequencies` : "—"],
              ["CHK HEIGHTS", result.checkHeights?.filter(c => c.alt)?.length ? `${result.checkHeights.filter(c => c.alt).length} points` : "—"],
            ].map(([l, v]) => (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", borderBottom: `1px solid ${C.border}`, padding: "3px 0" }}>
                <span style={{ color: C.textSub }}>{l}</span>
                <span style={{ color: C.text, fontWeight: 600 }}>{v}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Plate Library */}
      <Card>
        <CardTitle icon="◈">PLATE LIBRARY ({library.length})</CardTitle>
        <Input type="text" value={libSearch}
          onChange={e => setLibSearch(e.target.value)}
          placeholder="Search ICAO, name, type…" style={{ marginBottom: 10 }} />

        {filteredLib.length === 0 && (
          <div style={{ textAlign: "center", color: C.textMuted, padding: 20, fontSize: 12 }}>
            {library.length === 0
              ? "No plates ingested yet. Upload your first plate above."
              : "No matches."}
          </div>
        )}

        {filteredLib.map(plate => {
          const col = typeColor(plate.approachType);
          const minima = plate.da
            ? `DA ${plate.da}ft / ${plate.daVis || "?"}km`
            : plate.mda
            ? `MDA ${plate.mda}ft / ${plate.visibility || "?"}km`
            : plate.lnavMda
            ? `LNAV ${plate.lnavMda}ft`
            : "—";
          return (
            <div key={plate._id} style={{ background: C.surfaceRaise, border: `1px solid ${C.border}`, borderRadius: 8, padding: "11px 13px", marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                <div>
                  <span style={{ fontSize: 16, fontWeight: 700, color: C.accent, fontFamily: "monospace" }}>{plate.icao}</span>
                  {plate.aeroName && <span style={{ fontSize: 11, color: C.textSub, marginLeft: 8 }}>{plate.aeroName}</span>}
                </div>
                <Pill color={col}>{plate.approachType} {plate.runway}</Pill>
              </div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
                {plate.holdInbound && <Pill color={C.blue}>INBOUND {plate.holdInbound}°M</Pill>}
                {plate.holdAlt && <Pill color={C.textSub}>{plate.holdAlt}ft</Pill>}
                {plate.holdTurnDir && <Pill color={plate.holdTurnDir === "R" ? C.green : C.s2}>{plate.holdTurnDir === "R" ? "R/H" : "L/H"}</Pill>}
                {plate.msa && <Pill color={C.textSub}>MSA {plate.msa}ft</Pill>}
              </div>
              <div style={{ fontSize: 10, color: C.textSub, fontFamily: "monospace", marginBottom: 8 }}>
                {minima} · {plate.chartDate || "No date"} · {plate.checkHeights?.filter(c => c.alt)?.length || 0} check heights
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={() => loadPlate(plate)}
                  style={{ flex: 1, background: C.accentDim, border: `1px solid ${C.accent}`, borderRadius: 6, color: C.accent, cursor: "pointer", padding: "9px", fontSize: 10, fontFamily: "monospace", fontWeight: 700, letterSpacing: 1 }}>
                  LOAD TO BRIEF
                </button>
                <button
                  onClick={() => setPreview(preview?._id === plate._id ? null : plate)}
                  style={{ background: C.blueDim, border: `1px solid ${C.blue}`, borderRadius: 6, color: C.blue, cursor: "pointer", padding: "9px 12px", fontSize: 10, fontFamily: "monospace" }}>
                  {preview?._id === plate._id ? "HIDE" : "VIEW"}
                </button>
                <button
                  onClick={() => deletePlate(plate._id)}
                  style={{ background: C.redDim, border: `1px solid ${C.red}`, borderRadius: 6, color: C.red, cursor: "pointer", padding: "9px 12px", fontSize: 10, fontFamily: "monospace" }}>
                  ✕
                </button>
              </div>

              {/* Inline data view */}
              {preview?._id === plate._id && (
                <div style={{ marginTop: 10, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "10px", fontSize: 10, fontFamily: "monospace", lineHeight: 1.9 }}>
                  {plate.freqs?.map((f, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", borderBottom: `1px solid ${C.border}` }}>
                      <span style={{ color: C.textSub }}>{f.label}</span>
                      <span style={{ color: C.accent }}>{f.freq}</span>
                    </div>
                  ))}
                  {plate.checkHeights?.filter(c => c.alt)?.map((ch, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", borderBottom: `1px solid ${C.border}` }}>
                      <span style={{ color: C.textSub }}>{ch.fix || ch.dist ? `${ch.fix || ""} ${ch.dme || ch.dist + "NM" || ""}`.trim() : `CHK ${i+1}`}</span>
                      <span style={{ color: C.text }}>{ch.alt}ft</span>
                    </div>
                  ))}
                  {plate.missedDetail && (
                    <div style={{ marginTop: 6, color: C.textSub }}>{plate.missedDetail}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </Card>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── v3.0 — Aircraft Profile Store ───────────────────────────────────────────
function useAircraftProfiles() {
  const [profiles, setProfiles] = useState(() => {
    try { return JSON.parse(localStorage.getItem("holdmaster_aircraft") || "[]"); }
    catch { return []; }
  });
  const [activeId, setActiveId] = useState(() => {
    try { return localStorage.getItem("holdmaster_active_aircraft") || null; }
    catch { return null; }
  });

  const save = (list) => {
    setProfiles(list);
    try { localStorage.setItem("holdmaster_aircraft", JSON.stringify(list)); } catch {}
  };

  const setActive = (id) => {
    setActiveId(id);
    try { localStorage.setItem("holdmaster_active_aircraft", id || ""); } catch {}
  };

  const addProfile = (profile) => {
    const id = profile.id || `AC_${Date.now()}`;
    const withId = { ...profile, id };
    const next = [...profiles.filter(p => p.id !== id), withId];
    save(next);
    return id;
  };

  const deleteProfile = (id) => {
    save(profiles.filter(p => p.id !== id));
    if (activeId === id) setActive(null);
  };

  const active = profiles.find(p => p.id === activeId) || null;

  return { profiles, active, activeId, setActive, addProfile, deleteProfile };
}

// ─── v3.0 — Weight & Balance Tab ──────────────────────────────────────────────
function WBTab({ aircraft }) {
  const defaultRows = () => aircraft?.wbStations?.length
    ? aircraft.wbStations.map(s => ({ name: s.name, arm: s.arm, weight: "" }))
    : [
        { name: "Empty Weight", arm: "", weight: "" },
        { name: "Pilot + Front Pax", arm: "", weight: "" },
        { name: "Rear Pax", arm: "", weight: "" },
        { name: "Fuel", arm: "", weight: "" },
        { name: "Baggage", arm: "", weight: "" },
      ];

  const [rows, setRows] = useState(defaultRows);

  useEffect(() => { setRows(defaultRows()); }, [aircraft?.id]);

  const setRow = (i, field, val) => {
    const next = [...rows];
    next[i] = { ...next[i], [field]: val };
    setRows(next);
  };
  const addRow = () => setRows([...rows, { name: "", arm: "", weight: "" }]);
  const delRow = (i) => setRows(rows.filter((_, idx) => idx !== i));

  const wb = calcWB(rows);
  const hasData = wb.totalWeight > 0;

  const mtow = parseFloat(aircraft?.mtow) || null;
  const overMTOW = mtow && wb.totalWeight > mtow;
  const cgMin = parseFloat(aircraft?.cgMin) || null;
  const cgMax = parseFloat(aircraft?.cgMax) || null;
  const cgOutOfRange = (cgMin !== null && wb.cg < cgMin) || (cgMax !== null && wb.cg > cgMax);

  return (
    <div>
      {!aircraft && (
        <Card style={{ borderColor: C.s2 }}>
          <div style={{ fontSize: 11, color: C.s2, lineHeight: 1.7 }}>
            ⚠ No aircraft profile selected. Set one up in the AIRCRAFT tab for arms/limits to auto-fill.
            You can still use this tab manually.
          </div>
        </Card>
      )}

      <Card>
        <CardTitle icon="◈">STATIONS</CardTitle>
        {rows.map((r, i) => {
          const moment = (parseFloat(r.weight) || 0) * (parseFloat(r.arm) || 0);
          return (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "flex-end" }}>
              <div style={{ flex: 1.4 }}>
                <Label>Station</Label>
                <Input type="text" value={r.name} onChange={e => setRow(i, "name", e.target.value)} placeholder="Baggage" />
              </div>
              <div style={{ flex: 1 }}>
                <Label>Weight</Label>
                <Input value={r.weight} onChange={e => setRow(i, "weight", e.target.value)} placeholder="0" />
              </div>
              <div style={{ flex: 1 }}>
                <Label>Arm (in)</Label>
                <Input value={r.arm} onChange={e => setRow(i, "arm", e.target.value)} placeholder="0" />
              </div>
              <div style={{ flex: 1.1, fontSize: 10, color: C.textSub, paddingBottom: 10, textAlign: "right", fontFamily: "monospace" }}>
                {moment ? moment.toFixed(0) : "—"}
              </div>
              <button onClick={() => delRow(i)} style={{ background: C.redDim, border: `1px solid ${C.red}`, borderRadius: 6, color: C.red, cursor: "pointer", padding: "9px 11px", fontFamily: "monospace" }}>✕</button>
            </div>
          );
        })}
        <button onClick={addRow} style={{ background: C.surfaceRaise, border: `1px solid ${C.border}`, borderRadius: 6, color: C.textSub, cursor: "pointer", padding: "8px 14px", fontSize: 11, fontFamily: "monospace", width: "100%" }}>+ ADD STATION</button>
      </Card>

      {hasData && (
        <Card style={{ borderColor: (overMTOW || cgOutOfRange) ? C.red : C.green + "44" }}>
          <CardTitle icon="◈">RESULT</CardTitle>
          <DataRow label="TOTAL WEIGHT" value={`${wb.totalWeight.toFixed(1)} lb`} valueColor={overMTOW ? C.red : C.text} large />
          {mtow && <DataRow label="MTOW" value={`${mtow} lb`} valueColor={C.textSub} />}
          {mtow && <DataRow label="MARGIN" value={`${(mtow - wb.totalWeight).toFixed(1)} lb`} valueColor={overMTOW ? C.red : C.green} />}
          <DataRow label="TOTAL MOMENT" value={wb.totalMoment.toFixed(0)} />
          <DataRow label="CG" value={`${wb.cg.toFixed(2)} in`} valueColor={cgOutOfRange ? C.red : C.accent} large />
          {(cgMin !== null || cgMax !== null) && (
            <DataRow label="CG LIMITS" value={`${cgMin ?? "?"} – ${cgMax ?? "?"} in`} valueColor={C.textSub} />
          )}
          {overMTOW && <div style={S3.warnBox}>⚠ OVER MAX TAKEOFF WEIGHT by {(wb.totalWeight - mtow).toFixed(1)} lb</div>}
          {cgOutOfRange && <div style={S3.warnBox}>⚠ CG OUTSIDE APPROVED LIMITS</div>}
          {!overMTOW && !cgOutOfRange && (mtow || cgMin) && (
            <div style={{ background: C.greenDim, border: `1px solid ${C.green}`, borderRadius: 6, padding: "8px 12px", fontSize: 11, color: C.green, fontFamily: "monospace", fontWeight: 700 }}>
              ✓ WITHIN LIMITS
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// ─── v3.0 — Performance Tab ───────────────────────────────────────────────────
function PerfTab({ aircraft }) {
  const [fieldElev, setFieldElev] = useState("");
  const [qnh, setQnh] = useState("1013");
  const [oat, setOat] = useState("");
  const [weight, setWeight] = useState("");
  const [mode, setMode] = useState("takeoff"); // takeoff | landing

  const chart = mode === "takeoff" ? aircraft?.takeoffChart : aircraft?.landingChart;

  const fe = parseFloat(fieldElev), q = parseFloat(qnh), o = parseFloat(oat), w = parseFloat(weight);
  const hasInputs = !isNaN(fe) && !isNaN(q) && !isNaN(o);

  const pa = hasInputs ? pressureAltitude(fe, q) : null;
  const da = hasInputs ? densityAltitude(pa, o) : null;
  const isaDev = hasInputs ? (o - isaTempAt(pa)).toFixed(1) : null;

  // Chart is a simple 2-point table: { paLow, paHigh, tempLow, tempHigh, distLowLow, distHighLow, distLowHigh, distHighHigh }
  let interpDist = null;
  if (chart && hasInputs && chart.paLow !== undefined) {
    interpDist = bilinearInterp(
      pa, o,
      parseFloat(chart.paLow), parseFloat(chart.paHigh),
      parseFloat(chart.tempLow), parseFloat(chart.tempHigh),
      parseFloat(chart.distLowLow), parseFloat(chart.distHighLow),
      parseFloat(chart.distLowHigh), parseFloat(chart.distHighHigh)
    );
  }

  return (
    <div>
      <Card>
        <CardTitle icon="◈">CONDITIONS</CardTitle>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <SegBtn active={mode === "takeoff"} onClick={() => setMode("takeoff")}>TAKEOFF</SegBtn>
          <SegBtn active={mode === "landing"} onClick={() => setMode("landing")}>LANDING</SegBtn>
        </div>
        <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
          <div style={{ flex: 1 }}><Label>Field Elevation (ft)</Label><Input value={fieldElev} onChange={e => setFieldElev(e.target.value)} placeholder="435" /></div>
          <div style={{ flex: 1 }}><Label>QNH (hPa)</Label><Input value={qnh} onChange={e => setQnh(e.target.value)} placeholder="1013" /></div>
        </div>
        <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
          <div style={{ flex: 1 }}><Label>OAT (°C)</Label><Input value={oat} onChange={e => setOat(e.target.value)} placeholder="25" /></div>
          <div style={{ flex: 1 }}><Label>Weight (lb, opt)</Label><Input value={weight} onChange={e => setWeight(e.target.value)} placeholder="2208" /></div>
        </div>
      </Card>

      {hasInputs && (
        <Card>
          <CardTitle icon="◈">ATMOSPHERIC</CardTitle>
          <DataRow label="PRESSURE ALTITUDE" value={`${Math.round(pa)} ft`} valueColor={C.accent} large />
          <DataRow label="DENSITY ALTITUDE" value={`${Math.round(da)} ft`} valueColor={da > (fe + 3000) ? C.red : da > (fe + 1500) ? C.s2 : C.green} large />
          <DataRow label="ISA DEVIATION" value={`${isaDev > 0 ? "+" : ""}${isaDev}°C`} />
          <div style={S3.notesBox}>
            <div>• DA {'>'} field elev + 3000ft: significant performance degradation expected.</div>
            <div>• Always cross-check against your POH chart directly — this is an estimate.</div>
          </div>
        </Card>
      )}

      {interpDist !== null && (
        <Card style={{ borderColor: C.accent + "44" }}>
          <CardTitle icon="◈">{mode === "takeoff" ? "TAKEOFF GROUND ROLL (EST)" : "LANDING GROUND ROLL (EST)"}</CardTitle>
          <DataRow label="INTERPOLATED DISTANCE" value={`${Math.round(interpDist)} ft`} valueColor={C.accent} large />
          <div style={S3.notesBox}>
            Bilinear interpolation from your saved {mode} chart corner values. Verify against the actual POH before flight.
          </div>
        </Card>
      )}

      {!chart && hasInputs && (
        <Card>
          <div style={{ fontSize: 11, color: C.textSub, lineHeight: 1.7 }}>
            No {mode} performance chart saved for this aircraft. Add corner values (2 pressure altitudes × 2 temperatures) in the AIRCRAFT tab to enable distance interpolation.
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── v3.0 — Aircraft Tab (profile editor) ─────────────────────────────────────
function AircraftTab({ aircraftHook }) {
  const { profiles, active, activeId, setActive, addProfile, deleteProfile } = aircraftHook;
  const [editing, setEditing] = useState(null); // profile being edited, or null

  const blank = () => ({
    id: null, tail: "", type: "", mtow: "", cgMin: "", cgMax: "",
    wbStations: [
      { name: "Empty Weight", arm: "" },
      { name: "Pilot + Front Pax", arm: "" },
      { name: "Rear Pax", arm: "" },
      { name: "Fuel", arm: "" },
      { name: "Baggage", arm: "" },
    ],
    cruiseTas: "", fuelFlow: "", fuelUnit: "L",
    takeoffChart: { paLow: "0", paHigh: "2000", tempLow: "15", tempHigh: "35", distLowLow: "", distHighLow: "", distLowHigh: "", distHighHigh: "" },
    landingChart: { paLow: "0", paHigh: "2000", tempLow: "15", tempHigh: "35", distLowLow: "", distHighLow: "", distLowHigh: "", distHighHigh: "" },
  });

  const startNew = () => setEditing(blank());
  const startEdit = (p) => setEditing({ ...blank(), ...p });
  const cancel = () => setEditing(null);

  const saveEditing = () => {
    if (!editing.tail.trim()) return;
    const id = addProfile(editing);
    setActive(id);
    setEditing(null);
  };

  const setField = (field, val) => setEditing(prev => ({ ...prev, [field]: val }));
  const setStation = (i, field, val) => {
    const stations = [...editing.wbStations];
    stations[i] = { ...stations[i], [field]: val };
    setField("wbStations", stations);
  };
  const addStation = () => setField("wbStations", [...editing.wbStations, { name: "", arm: "" }]);
  const delStation = (i) => setField("wbStations", editing.wbStations.filter((_, idx) => idx !== i));

  const setChart = (chartKey, field, val) => {
    setEditing(prev => ({ ...prev, [chartKey]: { ...prev[chartKey], [field]: val } }));
  };

  if (editing) {
    return (
      <div>
        <Card>
          <CardTitle icon="◈">AIRCRAFT DETAILS</CardTitle>
          <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            <div style={{ flex: 1 }}><Label>Tail Number</Label><Input type="text" value={editing.tail} onChange={e => setField("tail", e.target.value.toUpperCase())} placeholder="VH-ABC" /></div>
            <div style={{ flex: 1 }}><Label>Type</Label><Input type="text" value={editing.type} onChange={e => setField("type", e.target.value)} placeholder="C172S" /></div>
          </div>
          <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            <div style={{ flex: 1 }}><Label>MTOW (lb)</Label><Input value={editing.mtow} onChange={e => setField("mtow", e.target.value)} placeholder="2550" /></div>
            <div style={{ flex: 1 }}><Label>CG Min (in)</Label><Input value={editing.cgMin} onChange={e => setField("cgMin", e.target.value)} placeholder="35.0" /></div>
            <div style={{ flex: 1 }}><Label>CG Max (in)</Label><Input value={editing.cgMax} onChange={e => setField("cgMax", e.target.value)} placeholder="47.3" /></div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}><Label>Cruise TAS (kt)</Label><Input value={editing.cruiseTas} onChange={e => setField("cruiseTas", e.target.value)} placeholder="110" /></div>
            <div style={{ flex: 1 }}><Label>Fuel Flow (per hr)</Label><Input value={editing.fuelFlow} onChange={e => setField("fuelFlow", e.target.value)} placeholder="32" /></div>
            <div style={{ flex: 1 }}>
              <Label>Unit</Label>
              <div style={{ display: "flex", gap: 6 }}>
                <SegBtn active={editing.fuelUnit === "L"} onClick={() => setField("fuelUnit", "L")}>L</SegBtn>
                <SegBtn active={editing.fuelUnit === "kg"} onClick={() => setField("fuelUnit", "kg")}>KG</SegBtn>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <CardTitle icon="◈">W&B STATIONS (ARMS)</CardTitle>
          <div style={{ fontSize: 10, color: C.textSub, marginBottom: 10 }}>Set each station's arm once — weight is entered per-flight in the WB tab.</div>
          {editing.wbStations.map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "flex-end" }}>
              <div style={{ flex: 1.5 }}><Label>Station</Label><Input type="text" value={s.name} onChange={e => setStation(i, "name", e.target.value)} placeholder="Baggage" /></div>
              <div style={{ flex: 1 }}><Label>Arm (in)</Label><Input value={s.arm} onChange={e => setStation(i, "arm", e.target.value)} placeholder="95.0" /></div>
              <button onClick={() => delStation(i)} style={{ background: C.redDim, border: `1px solid ${C.red}`, borderRadius: 6, color: C.red, cursor: "pointer", padding: "9px 11px", fontFamily: "monospace" }}>✕</button>
            </div>
          ))}
          <button onClick={addStation} style={{ background: C.surfaceRaise, border: `1px solid ${C.border}`, borderRadius: 6, color: C.textSub, cursor: "pointer", padding: "8px 14px", fontSize: 11, fontFamily: "monospace", width: "100%" }}>+ ADD STATION</button>
        </Card>

        {["takeoffChart", "landingChart"].map(chartKey => (
          <Card key={chartKey}>
            <CardTitle icon="◈">{chartKey === "takeoffChart" ? "TAKEOFF" : "LANDING"} CHART (OPTIONAL)</CardTitle>
            <div style={{ fontSize: 10, color: C.textSub, marginBottom: 10, lineHeight: 1.6 }}>
              Enter ground roll distance (ft) at 4 corner points from your POH: low/high pressure altitude × low/high temperature.
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <div style={{ flex: 1 }}><Label>PA Low (ft)</Label><Input value={editing[chartKey].paLow} onChange={e => setChart(chartKey, "paLow", e.target.value)} /></div>
              <div style={{ flex: 1 }}><Label>PA High (ft)</Label><Input value={editing[chartKey].paHigh} onChange={e => setChart(chartKey, "paHigh", e.target.value)} /></div>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <div style={{ flex: 1 }}><Label>Temp Low (°C)</Label><Input value={editing[chartKey].tempLow} onChange={e => setChart(chartKey, "tempLow", e.target.value)} /></div>
              <div style={{ flex: 1 }}><Label>Temp High (°C)</Label><Input value={editing[chartKey].tempHigh} onChange={e => setChart(chartKey, "tempHigh", e.target.value)} /></div>
            </div>
            <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 6, letterSpacing: 1 }}>DISTANCES (ft) AT EACH CORNER</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <div style={{ flex: 1 }}><Label>PA Low / Temp Low</Label><Input value={editing[chartKey].distLowLow} onChange={e => setChart(chartKey, "distLowLow", e.target.value)} placeholder="725" /></div>
              <div style={{ flex: 1 }}><Label>PA High / Temp Low</Label><Input value={editing[chartKey].distHighLow} onChange={e => setChart(chartKey, "distHighLow", e.target.value)} placeholder="850" /></div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}><Label>PA Low / Temp High</Label><Input value={editing[chartKey].distLowHigh} onChange={e => setChart(chartKey, "distLowHigh", e.target.value)} placeholder="850" /></div>
              <div style={{ flex: 1 }}><Label>PA High / Temp High</Label><Input value={editing[chartKey].distHighHigh} onChange={e => setChart(chartKey, "distHighHigh", e.target.value)} placeholder="1000" /></div>
            </div>
          </Card>
        ))}

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={saveEditing} style={{ flex: 1, background: C.accentDim, border: `1px solid ${C.accent}`, borderRadius: 8, color: C.accent, cursor: "pointer", padding: "14px", fontSize: 12, fontFamily: "monospace", fontWeight: 700, letterSpacing: 1.5 }}>SAVE PROFILE</button>
          <button onClick={cancel} style={{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 8, color: C.textSub, cursor: "pointer", padding: "14px 18px", fontSize: 12, fontFamily: "monospace" }}>CANCEL</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Card>
        <CardTitle icon="✈">AIRCRAFT PROFILES</CardTitle>
        <div style={{ fontSize: 10, color: C.textSub, marginBottom: 12, lineHeight: 1.7 }}>
          Save arms, limits, cruise performance, and takeoff/landing charts once per aircraft. Select an active aircraft to auto-fill WB and Performance tabs.
        </div>
        <button onClick={startNew} style={{ width: "100%", background: C.accentDim, border: `1px solid ${C.accent}`, borderRadius: 8, color: C.accent, cursor: "pointer", padding: "12px", fontSize: 11, fontFamily: "monospace", fontWeight: 700, letterSpacing: 1.5 }}>+ NEW AIRCRAFT PROFILE</button>
      </Card>

      {profiles.length === 0 && (
        <Card><div style={{ textAlign: "center", color: C.textMuted, padding: 20, fontSize: 12 }}>No aircraft profiles yet.</div></Card>
      )}

      {profiles.map(p => (
        <div key={p.id} style={{
          background: activeId === p.id ? C.accentDim : C.surfaceRaise,
          border: `1px solid ${activeId === p.id ? C.accent : C.border}`,
          borderRadius: 8, padding: "12px 14px", marginBottom: 8,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: activeId === p.id ? C.accent : C.text, fontFamily: "monospace" }}>{p.tail}</div>
              <div style={{ fontSize: 11, color: C.textSub }}>{p.type}</div>
            </div>
            {activeId === p.id && <Pill color={C.accent}>ACTIVE</Pill>}
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
            {p.mtow && <Pill color={C.textSub}>MTOW {p.mtow}lb</Pill>}
            {p.cruiseTas && <Pill color={C.blue}>{p.cruiseTas}kt cruise</Pill>}
            {p.fuelFlow && <Pill color={C.green}>{p.fuelFlow}{p.fuelUnit}/hr</Pill>}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {activeId !== p.id
              ? <button onClick={() => setActive(p.id)} style={{ flex: 1, background: C.accentDim, border: `1px solid ${C.accent}`, borderRadius: 6, color: C.accent, cursor: "pointer", padding: "9px", fontSize: 10, fontFamily: "monospace", fontWeight: 700 }}>SET ACTIVE</button>
              : <button onClick={() => setActive(null)} style={{ flex: 1, background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 6, color: C.textSub, cursor: "pointer", padding: "9px", fontSize: 10, fontFamily: "monospace" }}>DEACTIVATE</button>
            }
            <button onClick={() => startEdit(p)} style={{ background: C.blueDim, border: `1px solid ${C.blue}`, borderRadius: 6, color: C.blue, cursor: "pointer", padding: "9px 14px", fontSize: 10, fontFamily: "monospace" }}>EDIT</button>
            <button onClick={() => deleteProfile(p.id)} style={{ background: C.redDim, border: `1px solid ${C.red}`, borderRadius: 6, color: C.red, cursor: "pointer", padding: "9px 14px", fontSize: 10, fontFamily: "monospace" }}>✕</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── v3.0 — NAVLOG Tab ────────────────────────────────────────────────────────
function NavLogTab({ aircraft }) {
  const [legs, setLegs] = useState(() => {
    try { return JSON.parse(localStorage.getItem("holdmaster_navlog") || "[]"); }
    catch { return []; }
  });
  const [tas, setTas] = useState(() => aircraft?.cruiseTas || "");
  const [fuelFlow, setFuelFlow] = useState(() => aircraft?.fuelFlow || "");
  const [startFuel, setStartFuel] = useState("");

  useEffect(() => {
    if (aircraft?.cruiseTas && !tas) setTas(aircraft.cruiseTas);
    if (aircraft?.fuelFlow && !fuelFlow) setFuelFlow(aircraft.fuelFlow);
  }, [aircraft?.id]);

  const saveLegs = (next) => {
    setLegs(next);
    try { localStorage.setItem("holdmaster_navlog", JSON.stringify(next)); } catch {}
  };

  const addLeg = () => saveLegs([...legs, { from: "", to: "", track: "", dist: "", windDir: "", windSpd: "" }]);
  const setLeg = (i, field, val) => {
    const next = [...legs];
    next[i] = { ...next[i], [field]: val };
    saveLegs(next);
  };
  const delLeg = (i) => saveLegs(legs.filter((_, idx) => idx !== i));
  const clearAll = () => saveLegs([]);

  const tasN = parseFloat(tas) || 0;
  const ffN = parseFloat(fuelFlow) || 0;
  const startFuelN = parseFloat(startFuel) || 0;

  let cumTime = 0, cumFuel = 0, cumDist = 0;
  const computed = legs.map(leg => {
    const track = parseFloat(leg.track), dist = parseFloat(leg.dist);
    const wd = parseFloat(leg.windDir) || 0, ws = parseFloat(leg.windSpd) || 0;
    if (isNaN(track) || isNaN(dist) || !tasN) return { ...leg, invalid: true };
    const calc = calcNavLeg(track, dist, wd, ws, tasN, ffN);
    cumTime += calc.timeMin;
    cumFuel += calc.fuelUsed;
    cumDist += dist;
    return { ...leg, ...calc, cumTime, cumFuel, cumDist };
  });

  const validLegs = computed.filter(l => !l.invalid);
  const totalTime = validLegs.length ? validLegs[validLegs.length - 1].cumTime : 0;
  const totalFuel = validLegs.length ? validLegs[validLegs.length - 1].cumFuel : 0;
  const totalDist = validLegs.length ? validLegs[validLegs.length - 1].cumDist : 0;
  const fuelRemaining = startFuelN - totalFuel;

  return (
    <div>
      <Card>
        <CardTitle icon="◈">FLIGHT PARAMETERS</CardTitle>
        <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
          <div style={{ flex: 1 }}><Label>TAS (kt)</Label><Input value={tas} onChange={e => setTas(e.target.value)} placeholder="110" /></div>
          <div style={{ flex: 1 }}><Label>Fuel Flow (/hr)</Label><Input value={fuelFlow} onChange={e => setFuelFlow(e.target.value)} placeholder="32" /></div>
          <div style={{ flex: 1 }}><Label>Start Fuel</Label><Input value={startFuel} onChange={e => setStartFuel(e.target.value)} placeholder="150" /></div>
        </div>
        {aircraft && <div style={{ fontSize: 9, color: C.textMuted }}>Defaults from active aircraft: {aircraft.tail}</div>}
      </Card>

      <Card>
        <CardTitle icon="◈">LEGS</CardTitle>
        {computed.map((leg, i) => (
          <div key={i} style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px", marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <div style={{ flex: 1 }}><Label>From</Label><Input type="text" value={leg.from} onChange={e => setLeg(i, "from", e.target.value.toUpperCase())} placeholder="YMMB" /></div>
              <div style={{ flex: 1 }}><Label>To</Label><Input type="text" value={leg.to} onChange={e => setLeg(i, "to", e.target.value.toUpperCase())} placeholder="YMAV" /></div>
              <button onClick={() => delLeg(i)} style={{ background: C.redDim, border: `1px solid ${C.red}`, borderRadius: 6, color: C.red, cursor: "pointer", padding: "9px 11px", fontFamily: "monospace", alignSelf: "flex-end" }}>✕</button>
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <div style={{ flex: 1 }}><Label>Track (°M)</Label><Input value={leg.track} onChange={e => setLeg(i, "track", e.target.value)} placeholder="270" /></div>
              <div style={{ flex: 1 }}><Label>Dist (NM)</Label><Input value={leg.dist} onChange={e => setLeg(i, "dist", e.target.value)} placeholder="35" /></div>
              <div style={{ flex: 1 }}><Label>Wind Dir</Label><Input value={leg.windDir} onChange={e => setLeg(i, "windDir", e.target.value)} placeholder="250" /></div>
              <div style={{ flex: 1 }}><Label>Wind Spd</Label><Input value={leg.windSpd} onChange={e => setLeg(i, "windSpd", e.target.value)} placeholder="15" /></div>
            </div>
            {!leg.invalid && leg.gs !== undefined && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, fontFamily: "monospace", paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
                {[
                  ["HDG", `${leg.heading}°M`, C.accent],
                  ["GS", `${leg.gs}kt`, C.blue],
                  ["TIME", fmtHM(leg.timeMin), C.text],
                  ["FUEL", leg.fuelUsed, C.s2],
                ].map(([l, v, c]) => (
                  <div key={l} style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 8, color: C.textSub, letterSpacing: 1 }}>{l}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: c }}>{v}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={addLeg} style={{ flex: 1, background: C.surfaceRaise, border: `1px solid ${C.border}`, borderRadius: 6, color: C.textSub, cursor: "pointer", padding: "10px 14px", fontSize: 11, fontFamily: "monospace" }}>+ ADD LEG</button>
          {legs.length > 0 && <button onClick={clearAll} style={{ background: C.redDim, border: `1px solid ${C.red}`, borderRadius: 6, color: C.red, cursor: "pointer", padding: "10px 14px", fontSize: 11, fontFamily: "monospace" }}>CLEAR</button>}
        </div>
      </Card>

      {validLegs.length > 0 && (
        <Card style={{ borderColor: C.accent + "44", background: C.surfaceHigh }}>
          <CardTitle icon="✈">TOTALS</CardTitle>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px", fontFamily: "monospace" }}>
            {[
              ["TOTAL DIST", `${totalDist.toFixed(0)} NM`, C.text],
              ["TOTAL TIME", fmtHM(totalTime), C.accent],
              ["TOTAL FUEL", `${totalFuel.toFixed(1)} ${aircraft?.fuelUnit || ""}`, C.s2],
              ...(startFuelN > 0 ? [["FUEL REMAINING", `${fuelRemaining.toFixed(1)} ${aircraft?.fuelUnit || ""}`, fuelRemaining < startFuelN * 0.2 ? C.red : C.green]] : []),
            ].map(([l, v, c]) => (
              <div key={l} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 8, color: C.textSub, letterSpacing: 1.5, textTransform: "uppercase" }}>{l}</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: c }}>{v}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── v3.0 — METAR/TAF Tab ─────────────────────────────────────────────────────
function WxTab() {
  const [raw, setRaw] = useState("");
  const parsed = raw.trim().length > 10 ? parseMETAR(raw) : null;
  const cat = parsed ? flightCategory(parsed.vis, parsed.ceiling) : null;

  return (
    <div>
      <Card>
        <CardTitle icon="📡">METAR DECODER</CardTitle>
        <div style={{ fontSize: 10, color: C.textSub, marginBottom: 10, lineHeight: 1.7 }}>
          Paste a raw METAR. Fully offline — no network required.
        </div>
        <textarea
          value={raw}
          onChange={e => setRaw(e.target.value)}
          placeholder="YSSY 231400Z 25012KT 9999 FEW030 22/15 Q1018 NOSIG"
          style={{ width: "100%", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, padding: "10px 12px", fontSize: 12, fontFamily: "monospace", boxSizing: "border-box", outline: "none", resize: "vertical", minHeight: 70, lineHeight: 1.6 }}
        />
      </Card>

      {parsed && (
        <>
          {cat && (
            <Card style={{ borderColor: cat.color }}>
              <div style={{ textAlign: "center", padding: "8px 0" }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: cat.color, fontFamily: "monospace", letterSpacing: 3 }}>{cat.cat}</div>
                <div style={{ fontSize: 10, color: C.textSub, marginTop: 4 }}>
                  {parsed.cavok ? "CAVOK" : `Vis ${parsed.vis}m${parsed.ceiling ? ` · Ceiling ${parsed.ceiling}ft` : ""}`}
                </div>
              </div>
            </Card>
          )}

          <Card>
            <CardTitle icon="◈">DECODED</CardTitle>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px", fontFamily: "monospace" }}>
              {[
                parsed.icao && ["ICAO", parsed.icao, C.accent],
                parsed.time && ["TIME", `${parsed.time.slice(0,2)}${parsed.time.slice(2,4)}:${parsed.time.slice(4,6)}Z`, C.text],
                parsed.windDir !== undefined && ["WIND", parsed.windVariable ? `VRB/${parsed.windSpd}kt` : `${String(parsed.windDir).padStart(3,"0")}°/${parsed.windSpd}kt${parsed.gust ? ` G${parsed.gust}` : ""}`, C.blue],
                parsed.vis !== undefined && ["VIS", parsed.cavok ? "CAVOK" : `${parsed.vis}m`, C.text],
                parsed.ceiling && ["CEILING", `${parsed.ceiling}ft`, parsed.ceiling > 2000 ? C.green : parsed.ceiling > 1000 ? C.s2 : C.red],
                parsed.temp !== undefined && ["TEMP/DEW", `${parsed.temp}°/${parsed.dew}°`, C.text],
                parsed.qnh && ["QNH", `${parsed.qnh} hPa`, C.accent],
                parsed.trend && ["TREND", parsed.trend, C.text],
                parsed.weather?.length && ["WX", parsed.weather.join(" "), C.s2],
              ].filter(Boolean).map(([l, v, c]) => (
                <div key={l} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 8, color: C.textSub, letterSpacing: 1.5, textTransform: "uppercase" }}>{l}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: c }}>{v}</span>
                </div>
              ))}
            </div>
            {parsed.clouds?.length > 0 && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}`, fontSize: 10, color: C.textSub, fontFamily: "monospace" }}>
                {parsed.clouds.map((cl, i) => (
                  <span key={i} style={{ marginRight: 12, color: cl.cover === "BKN" || cl.cover === "OVC" ? C.text : C.textSub }}>
                    {cl.cover}{String(cl.alt / 100).padStart(3, "0")}{cl.type || ""}
                  </span>
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      <Card>
        <CardTitle icon="◈">FLIGHT CATEGORY BANDS</CardTitle>
        <div style={S3.notesBox}>
          <div>• VFR: vis ≥8000m, ceiling ≥3000ft</div>
          <div>• MVFR: vis ≥5000m, ceiling ≥1000ft</div>
          <div>• IFR: vis ≥1600m, ceiling ≥500ft</div>
          <div>• LIFR: below IFR minimums</div>
          <div style={{ marginTop: 6, color: C.textMuted }}>Simplified bands for quick reference — always check current AIP for regulatory minima.</div>
        </div>
      </Card>
    </div>
  );
}

// ─── Main App
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
  // Fuel
  const [fuelFlow, setFuelFlow]         = useState("");
  const [fuelUnit, setFuelUnit]         = useState("L");
  const [fuelReserve, setFuelReserve]   = useState("");

  // ── Memory bank ──
  const [memories, setMemories] = useState(() => {
    try { return JSON.parse(localStorage.getItem("holdmaster_v2") || "{}"); }
    catch { return {}; }
  });
  const [memSearch, setMemSearch] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  // v3.0 — Aircraft profiles (shared across NAVLOG, W&B, PERF tabs)
  const aircraftHook = useAircraftProfiles();

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
  const ff   = parseFloat(fuelFlow);
  const fr   = parseFloat(fuelReserve);

  const validBase = !isNaN(inb) && inb >= 0 && inb <= 360 && !isNaN(alt) && alt > 0;
  const hasSpeed  = validBase && !isNaN(tasN) && tasN > 0;
  const hasHdg    = validBase && !isNaN(hdg) && hdg >= 0 && hdg <= 360;
  const hasWind   = hasSpeed && !isNaN(wd) && !isNaN(ws) && ws >= 0;
  const hasFuel   = !isNaN(ff) && ff > 0;

  const maxSpd   = validBase ? getMaxSpeed(cat, alt) : null;
  const legSecs  = validBase ? getLegTimeSecs(alt, chartedMin) : null;
  const entry    = hasHdg    ? getSectorEntry(hdg, inb, turnDir) : null;
  const windCalc = hasWind   ? calcWind(inb, wd, ws, tasN) : null;
  const outAdj   = hasWind   ? calcOutboundTime(inb, wd, ws, tasN, legSecs) : null;
  const speedWarn = hasSpeed && tasN > maxSpd;

  // Fuel calcs — per lap = 2× leg time (outbound + inbound) + 2 turns (~0.5min each)
  const lapSecs    = legSecs ? (outAdj?.secs || legSecs) + legSecs + 60 : null;
  const lapMins    = lapSecs ? lapSecs / 60 : null;
  const fuelPerLap = hasFuel && lapMins ? (ff / 60) * lapMins : null;
  const fuelAvail  = hasFuel && !isNaN(fr) && fr > 0 ? fr : null;
  const lapsAvail  = fuelAvail && fuelPerLap ? Math.floor(fuelAvail / fuelPerLap) : null;
  const enduranceMins = fuelAvail && hasFuel ? Math.floor((fuelAvail / ff) * 60) : null;

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

  const delMemory = (k) => { setMemories(p => { const n = { ...p }; delete n[k]; return n; }); setDeleteConfirm(null); };

  const memKeys = Object.keys(memories).filter(k => k.toLowerCase().includes(memSearch.toLowerCase())).sort();

  // ── Styles ──
  const S = {
    app:      { background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "'SF Mono','Fira Mono',Consolas,monospace", fontSize: 13, paddingBottom: 60 },
    header:   { background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "16px 16px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" },
    tabs:     { display: "flex", borderBottom: `1px solid ${C.border}`, background: C.surface, overflowX: "auto", scrollSnapType: "x proximity", WebkitOverflowScrolling: "touch" },
    tab:   (a) => ({ flex: "0 0 auto", minWidth: 64, padding: "12px 10px", cursor: "pointer", fontSize: 8.5, letterSpacing: 1.8, fontFamily: "monospace", fontWeight: a ? 700 : 400, color: a ? C.accent : C.textSub, borderBottom: a ? `2px solid ${C.accent}` : "2px solid transparent", background: "none", border: "none", borderBottom: a ? `2px solid ${C.accent}` : "2px solid transparent", whiteSpace: "nowrap" }),
    body:     { padding: "14px", maxWidth: 500, margin: "0 auto" },
    row2:     { display: "flex", gap: 10, marginBottom: 10 },
    field:    { flex: 1, display: "flex", flexDirection: "column" },
    warnBox:  { background: "#2A1500", border: `1px solid #7A4000`, borderRadius: 8, padding: "10px 12px", fontSize: 11, color: C.accent, marginBottom: 10, lineHeight: 1.6 },
    notesBox: { background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, padding: "10px 12px", fontSize: 10.5, color: C.textSub, lineHeight: 1.8, marginTop: 10 },
    memCard:  { background: C.surfaceRaise, border: `1px solid ${C.border}`, borderRadius: 8, padding: "11px 13px", marginBottom: 8 },
    btnPrim:  { background: C.accentDim, border: `1px solid ${C.accent}`, borderRadius: 6, color: C.accent, cursor: "pointer", padding: "10px 16px", fontSize: 10.5, fontFamily: "monospace", fontWeight: 700, letterSpacing: 1.5, flexShrink: 0 },
    btnDanger:{ background: C.redDim, border: `1px solid ${C.red}`, borderRadius: 6, color: C.red, cursor: "pointer", padding: "8px 12px", fontSize: 10, fontFamily: "monospace", fontWeight: 700, letterSpacing: 1 },
    btnNeutral:{ background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 6, color: C.textSub, cursor: "pointer", padding: "8px 12px", fontSize: 10, fontFamily: "monospace" },
    sectorBadge: (col) => ({ display: "inline-block", padding: "3px 12px", borderRadius: 12, fontSize: 10, fontWeight: 700, letterSpacing: 1.5, background: col + "18", color: col, border: `1px solid ${col}`, marginBottom: 10 }),
    stepItem: { display: "flex", gap: 9, marginBottom: 8, alignItems: "flex-start" },
    stepNum:  { flexShrink: 0, width: 20, height: 20, borderRadius: "50%", background: C.accentDim, color: C.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700 },
    stepText: { fontSize: 12, lineHeight: 1.6, color: C.text },
    refSection:{ background: C.surfaceRaise, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 14px", marginBottom: 10 },
    refTitle:  { fontSize: 9, letterSpacing: 2, color: C.textSub, textTransform: "uppercase", marginBottom: 10, fontFamily: "monospace" },
    refRow:    { display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: `1px solid ${C.border}` },
  };

  const TABS = [
    { id: "calc",     label: "HOLD" },
    { id: "entry",    label: "SECTORS" },
    { id: "wind",     label: "WIND" },
    { id: "brief",    label: "BRIEF" },
    { id: "plates",   label: "PLATES" },
    { id: "navlog",   label: "NAVLOG" },
    { id: "wb",       label: "W&B" },
    { id: "perf",     label: "PERF" },
    { id: "wx",       label: "WX" },
    { id: "aircraft", label: "AIRCRAFT" },
    { id: "memory",   label: "MEMORY" },
    { id: "ref",      label: "REF" },
  ];

  return (
    <div style={S.app}>
      {/* Header */}
      <div style={S.header}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.accent, letterSpacing: 3 }}>✈ HOLDMASTER</div>
          <div style={{ fontSize: 9, color: C.textSub, letterSpacing: 2, marginTop: 2 }}>AU AIP ENR 1.5 · v{VERSION}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <Pill color={C.green}>CASA</Pill>
          {Object.keys(memories).length > 0 && <Pill color={C.blue}>{Object.keys(memories).length} SAVED</Pill>}
        </div>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {TABS.map(({ id, label }) => (
          <button key={id} style={S.tab(tab === id)} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      <div style={S.body}>

        {/* ── HOLD TAB ── */}
        {tab === "calc" && (
          <>
            <Card>
              <CardTitle icon="◈">HOLD PARAMETERS</CardTitle>
              <div style={S.row2}>
                <div style={S.field}><Label>Inbound Track (°M)</Label><Input value={inboundTrack} onChange={e => setInboundTrack(e.target.value)} placeholder="e.g. 152" /></div>
                <div style={S.field}><Label>Altitude (ft)</Label><Input value={altitude} onChange={e => setAltitude(e.target.value)} placeholder="e.g. 8000" /></div>
              </div>
              <div style={{ marginBottom: 10 }}>
                <Label>Turn Direction</Label>
                <div style={{ display: "flex", gap: 8 }}>
                  <SegBtn active={turnDir === "R"} onClick={() => setTurnDir("R")}>▶ RIGHT (STANDARD)</SegBtn>
                  <SegBtn active={turnDir === "L"} onClick={() => setTurnDir("L")}>◀ LEFT</SegBtn>
                </div>
              </div>
              <div style={{ marginBottom: 10 }}>
                <Label>Aircraft Category</Label>
                <Select value={cat} onChange={e => setCat(e.target.value)}>
                  {Object.entries(ICAO_CATS).map(([k, v]) => (
                    <option key={k} value={k}>{v.label} · Vat {v.vatRange} · Max {getMaxSpeed(k, alt || 0)}kt</option>
                  ))}
                </Select>
              </div>
              <div style={S.row2}>
                <div style={S.field}><Label>TAS / IAS (kt)</Label><Input value={tas} onChange={e => setTas(e.target.value)} placeholder="e.g. 120" /></div>
                <div style={S.field}><Label>Charted Leg (min)</Label><Input value={chartedMin} onChange={e => setChartedMin(e.target.value)} placeholder="auto" /></div>
              </div>
            </Card>

            {/* Hold Timer */}
            {validBase && <HoldTimer legSecs={legSecs} outAdjSecs={outAdj?.secs} />}

            {validBase && (
              <Card>
                <CardTitle icon="◈">HOLD TIMING</CardTitle>
                {speedWarn && <div style={S.warnBox}>⚠ {tasN}kt EXCEEDS Cat {cat} limit of {maxSpd}kt at this altitude.<br />AIP ENR 1.5: reduce to ≤{maxSpd}kt BEFORE the fix.</div>}
                <DataRow label="INBOUND TRACK" value={`${norm(inb)}°M`} valueColor={C.accent} large />
                <DataRow label="OUTBOUND HEADING" value={`${norm(inb + 180)}°M`} valueColor={C.accent} large />
                {windCalc && <>
                  <DataRow label="INBOUND HDG (corrected)" value={`${norm(inb - windCalc.wca)}°M`} valueColor={C.blue} />
                  <DataRow label="OUTBOUND HDG (corrected)" value={`${norm(norm(inb + 180) - windCalc.wca * 3)}°M`} valueColor={C.blue} />
                </>}
                <DataRow label="FL / ALT" value={`${alt}ft · FL${Math.round(alt / 100)}`} valueColor={alt / 100 > 140 ? C.s2 : C.green} />
                <DataRow label="INBOUND LEG TIME" value={alt / 100 <= 140 ? "1 MIN (≤FL140)" : "1.5 MIN (>FL140)"} valueColor={C.accent} large />
                {outAdj
                  ? <DataRow label="ADJUSTED OUTBOUND LEG" value={fmtTime(outAdj.secs)} valueColor={C.blue} large />
                  : <DataRow label="STANDARD OUTBOUND LEG" value={fmtTime(legSecs)} />}
                <DataRow label={`MAX SPEED · CAT ${cat}`} value={`${maxSpd} KIAS`} valueColor={speedWarn ? C.red : C.text} />
                {hasSpeed && <DataRow label="YOUR SPEED" value={`${tasN} kt`} valueColor={speedWarn ? C.red : C.green} />}
                {outAdj && <>
                  <DataRow label="GS INBOUND" value={`${outAdj.gsIn} kt`} valueColor={C.blue} />
                  <DataRow label="GS OUTBOUND" value={`${outAdj.gsOut} kt`} valueColor={C.blue} />
                  <DataRow label="TARGET INBOUND DIST" value={`${outAdj.distNM} NM`} valueColor={C.blue} />
                </>}
                {windCalc && <>
                  <DataRow label="INBOUND WCA" value={`${windCalc.wca > 0 ? "+" : ""}${windCalc.wca}°`} valueColor={C.blue} />
                  <DataRow label="OUTBOUND WCA (×3)" value={`${windCalc.wca * 3 > 0 ? "+" : ""}${windCalc.wca * 3}°`} valueColor={C.blue} />
                </>}
                <div style={S.notesBox}>
                  <div>• Timing starts ABEAM the fix or wings level after turn — whichever is later.</div>
                  <div>• Obtain inbound track BEFORE crossing the fix inbound. (ENR 1.5 para 3.1.5)</div>
                  <div>• Turns: standard rate; max bank 30° (flight director: 25°).</div>
                  {entry && entry.sector === 2 && <div>• S2 max outbound: 1.5 min even if chart shows 1 min.</div>}
                </div>
              </Card>
            )}

            {/* Fuel */}
            <Card>
              <CardTitle icon="⛽">FUEL ENDURANCE IN HOLD</CardTitle>
              <div style={S.row2}>
                <div style={S.field}><Label>Fuel Flow (per hr)</Label><Input value={fuelFlow} onChange={e => setFuelFlow(e.target.value)} placeholder="e.g. 30" /></div>
                <div style={S.field}>
                  <Label>Unit</Label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <SegBtn active={fuelUnit === "L"} onClick={() => setFuelUnit("L")}>L/HR</SegBtn>
                    <SegBtn active={fuelUnit === "kg"} onClick={() => setFuelUnit("kg")}>KG/HR</SegBtn>
                  </div>
                </div>
              </div>
              <div style={{ marginBottom: 10 }}>
                <Label>Available Fuel Above Reserve ({fuelUnit})</Label>
                <Input value={fuelReserve} onChange={e => setFuelReserve(e.target.value)} placeholder="e.g. 45" />
              </div>
              {hasFuel && lapMins && fuelPerLap && (
                <>
                  <DataRow label="FUEL PER LAP" value={`${fuelPerLap.toFixed(1)} ${fuelUnit}`} valueColor={C.accent} />
                  <DataRow label="EST. LAP TIME" value={fmtTime(Math.round(lapSecs))} />
                  {lapsAvail !== null && <DataRow label="LAPS AVAILABLE" value={lapsAvail} valueColor={lapsAvail <= 2 ? C.red : lapsAvail <= 4 ? C.s2 : C.green} large />}
                  {enduranceMins && <DataRow label="HOLD ENDURANCE" value={`${enduranceMins} MIN`} valueColor={C.blue} large />}
                </>
              )}
            </Card>

            {/* Hold Card */}
            {validBase && (
              <Card style={{ borderColor: C.accent + "44", background: C.surfaceHigh }}>
                <CardTitle icon="✈">HOLD CARD</CardTitle>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px", fontFamily: "monospace" }}>
                  {[
                    { l: "FIX INBOUND",    v: `${norm(inb)}°M`,             c: C.accent },
                    { l: "OUTBOUND",       v: `${norm(inb + 180)}°M`,        c: C.accent },
                    { l: "TURN",           v: turnDir === "R" ? "RIGHT ▶" : "◀ LEFT", c: C.green },
                    { l: "CAT",            v: cat,                            c: C.text },
                    { l: "ALT",            v: `${alt}ft / FL${Math.round(alt / 100)}`, c: alt / 100 > 140 ? C.s2 : C.green },
                    { l: "LEG TIME",       v: alt / 100 <= 140 ? "1 MIN" : "1.5 MIN", c: C.accent },
                    ...(outAdj ? [
                      { l: "OBD LEG (adj)", v: fmtTime(outAdj.secs), c: C.blue },
                      { l: "DIST",          v: `${outAdj.distNM} NM`, c: C.blue },
                    ] : [{ l: "OBD LEG", v: fmtTime(legSecs), c: C.text }]),
                    { l: "MAX SPEED", v: `${maxSpd} kt`, c: speedWarn ? C.red : C.text },
                    ...(windCalc ? [
                      { l: "IBD HDG",  v: `${norm(inb - windCalc.wca)}°M`,                  c: C.blue },
                      { l: "OBD HDG",  v: `${norm(norm(inb + 180) - windCalc.wca * 3)}°M`,  c: C.blue },
                      { l: "WCA ×3",   v: `${windCalc.wca * 3 > 0 ? "+" : ""}${windCalc.wca * 3}°`, c: C.blue },
                    ] : []),
                    ...(entry ? [{ l: "ENTRY", v: entry.badge, c: entry.color }] : []),
                    ...(lapsAvail !== null ? [{ l: "LAPS", v: String(lapsAvail), c: lapsAvail <= 2 ? C.red : C.green }] : []),
                  ].map(({ l, v, c }) => (
                    <div key={l} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ fontSize: 8, color: C.textSub, letterSpacing: 1.5, textTransform: "uppercase" }}>{l}</span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: c }}>{v}</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Entry summary */}
            {entry && (
              <Card style={{ borderColor: entry.borderColor }}>
                <CardTitle icon="◈">SECTOR ENTRY SUMMARY</CardTitle>
                <div style={S.sectorBadge(entry.color)}>{entry.badge}</div>
                <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                  {entry.procedure.map((step, i) => (
                    <li key={i} style={S.stepItem}>
                      <span style={S.stepNum}>{i + 1}</span>
                      <span style={S.stepText}>{step}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}

            {/* Save */}
            <Card>
              <CardTitle icon="◈">SAVE TO MEMORY</CardTitle>
              <div style={S.row2}>
                <div style={{ flex: 1 }}><Label>Airport / Fix Label</Label><Input type="text" value={saveKey} onChange={e => setSaveKey(e.target.value.toUpperCase())} placeholder="e.g. YMAV" /></div>
                <button style={{ ...S.btnPrim, alignSelf: "flex-end" }} onClick={saveMemory} disabled={!validBase || !saveKey.trim()}>
                  {saved ? "✓ SAVED" : "SAVE"}
                </button>
              </div>
            </Card>
          </>
        )}

        {/* ── SECTORS TAB ── */}
        {tab === "entry" && (
          <>
            <Card>
              <CardTitle icon="◈">SECTOR ENTRY</CardTitle>
              <div style={S.row2}>
                <div style={S.field}><Label>Inbound Track (°M)</Label><Input value={inboundTrack} onChange={e => setInboundTrack(e.target.value)} placeholder="e.g. 152" /></div>
                <div style={S.field}><Label>Turn Direction</Label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <SegBtn active={turnDir === "R"} onClick={() => setTurnDir("R")}>R</SegBtn>
                    <SegBtn active={turnDir === "L"} onClick={() => setTurnDir("L")}>L</SegBtn>
                  </div>
                </div>
              </div>
              <div><Label>AC Heading at Fix (°M)</Label><Input value={acHdg} onChange={e => setAcHdg(e.target.value)} placeholder="e.g. 342" /></div>
              <div style={{ fontSize: 10, color: C.textSub, marginTop: 8 }}>AIP ENR 1.5 para 3.4.1 — based on <strong style={{ color: C.text }}>heading</strong>, not ground track.</div>
            </Card>
            {!isNaN(inb) && (
              <Card>
                <CardTitle icon="◈">DIAGRAM</CardTitle>
                <HoldDiagram inboundTrack={inb} turnDir={turnDir} sector={entry?.sector ?? null} acHdg={!isNaN(hdg) ? hdg : null} />
                <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 10, flexWrap: "wrap" }}>
                  {[{ n: 1, label: "S1 PARALLEL", col: C.s1 }, { n: 2, label: "S2 OFFSET", col: C.s2 }, { n: 3, label: "S3 DIRECT", col: C.s3 }].map(({ n, label, col }) => (
                    <span key={n} style={{ ...S.sectorBadge(col), marginBottom: 0, opacity: entry ? (entry.sector === n ? 1 : 0.4) : 1 }}>{label}</span>
                  ))}
                </div>
              </Card>
            )}
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
                  <div>Outbound: {norm(inb + 180)}°M · S3/S1 line: {norm(norm(inb + 180) + (turnDir === "R" ? 110 : -110))}°M · S1/S2 line: {norm(norm(inb + 180) + (turnDir === "R" ? 290 : -290))}°M</div>
                  {entry.offsetHeading && <div style={{ color: C.accent }}>Offset heading (S2): {entry.offsetHeading}°M</div>}
                </div>
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
                <div style={S.field}><Label>Inbound Track (°M)</Label><Input value={inboundTrack} onChange={e => setInboundTrack(e.target.value)} placeholder="e.g. 152" /></div>
                <div style={S.field}><Label>TAS (kt)</Label><Input value={tas} onChange={e => setTas(e.target.value)} placeholder="e.g. 120" /></div>
              </div>
              <div style={S.row2}>
                <div style={S.field}><Label>Wind Direction (°T)</Label><Input value={windDir} onChange={e => setWindDir(e.target.value)} placeholder="e.g. 270" /></div>
                <div style={S.field}><Label>Wind Speed (kt)</Label><Input value={windSpd} onChange={e => setWindSpd(e.target.value)} placeholder="e.g. 20" /></div>
              </div>
            </Card>
            {hasWind && windCalc && (
              <>
                <Card>
                  <CardTitle icon="◈">INBOUND LEG</CardTitle>
                  <DataRow label="WIND COMPONENT" value={windCalc.hw >= 0 ? `↗ TAILWIND ${windCalc.hw}kt` : `↙ HEADWIND ${Math.abs(windCalc.hw)}kt`} valueColor={windCalc.hw >= 0 ? C.green : C.red} large />
                  <DataRow label="CROSSWIND" value={`${Math.abs(windCalc.xw)}kt`} />
                  <DataRow label="WCA (INBOUND)" value={`${windCalc.wca > 0 ? "+" : ""}${windCalc.wca}°`} valueColor={C.blue} />
                  <DataRow label="INBOUND HEADING" value={`${norm(inb - windCalc.wca)}°M`} valueColor={C.accent} large />
                  <DataRow label="GS INBOUND" value={`${windCalc.gsInbound}kt`} />
                </Card>
                <Card>
                  <CardTitle icon="◈">OUTBOUND LEG</CardTitle>
                  <DataRow label="WCA OUTBOUND (×3 inbound)" value={`${windCalc.wca * 3 > 0 ? "+" : ""}${windCalc.wca * 3}°`} valueColor={C.blue} />
                  <DataRow label="OUTBOUND HEADING" value={`${norm(norm(inb + 180) - windCalc.wca * 3)}°M`} valueColor={C.accent} large />
                  <DataRow label="ADJUSTED OUTBOUND TIME" value={outAdj ? fmtTime(outAdj.secs) : "—"} valueColor={C.blue} large />
                  {outAdj && <>
                    <DataRow label="GS OUTBOUND" value={`${outAdj.gsOut}kt`} />
                    <DataRow label="TARGET INBOUND DIST" value={`${outAdj.distNM} NM`} valueColor={C.blue} />
                  </>}
                </Card>
                <Card>
                  <CardTitle icon="◈">NOTES</CardTitle>
                  <div style={S.notesBox}>
                    <div>• Apply WCA on INBOUND: track {norm(inb)}°M → heading {norm(inb - windCalc.wca)}°M.</div>
                    <div>• Apply TRIPLE WCA on OUTBOUND: hdg {norm(norm(inb + 180) - windCalc.wca * 3)}°M.</div>
                    <div>• Adjust outbound timing so inbound leg = {legSecs ? fmtTime(legSecs) : "—"}.</div>
                    <div>• Lateral drift: re-evaluate each lap and refine WCA.</div>
                    <div>• (AU AIP ENR 1.5 para 3.1.4)</div>
                  </div>
                </Card>
              </>
            )}
            {!hasWind && <Card><div style={{ color: C.textSub, fontSize: 12, textAlign: "center", padding: 20 }}>Enter inbound track, TAS, and wind to see corrections.</div></Card>}
          </>
        )}

        {/* ── APPROACH BRIEF TAB ── */}
        {tab === "brief" && (
          <ApproachBriefTab windCalc={windCalc} sectorEntryFromCalc={entry} />
        )}

        {/* ── MEMORY TAB ── */}
        {tab === "memory" && (
          <>
            <Card>
              <CardTitle icon="◈">MEMORY BANK</CardTitle>
              <Input type="text" value={memSearch} onChange={e => setMemSearch(e.target.value)} placeholder="Search airport / label…" />
            </Card>
            {memKeys.length === 0 && (
              <Card><div style={{ textAlign: "center", color: C.textMuted, padding: 24, fontSize: 12 }}>
                {Object.keys(memories).length === 0 ? "No holds saved yet." : "No results."}
              </div></Card>
            )}
            {memKeys.map(k => {
              const m = memories[k];
              const sc = m.sector;
              const scCol = sc === 1 ? C.s1 : sc === 2 ? C.s2 : sc === 3 ? C.s3 : C.textSub;
              const fl = m.altitude ? Math.round(m.altitude / 100) : null;
              return (
                <div key={k} style={S.memCard}>
                  <div>
                    <div style={{ fontSize: 17, fontWeight: 700, color: C.accent, marginBottom: 6 }}>{k}</div>
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 6 }}>
                      {m.inboundTrack && <Pill color={C.blue}>INBOUND {m.inboundTrack}°M</Pill>}
                      {fl && <Pill color={C.textSub}>FL{fl}</Pill>}
                      {m.cat && <Pill color={C.green}>CAT {m.cat}</Pill>}
                      {sc && <Pill color={scCol}>S{sc}</Pill>}
                      {m.turnDir && <Pill color={m.turnDir === "R" ? C.green : C.s2}>{m.turnDir === "R" ? "R/H" : "L/H"}</Pill>}
                      {m.maxSpd && <Pill color={C.red}>MAX {m.maxSpd}kt</Pill>}
                    </div>
                    <div style={{ ...S.notesBox, marginTop: 8 }}>
                      {m.inboundTrack && <div>Inbound {m.inboundTrack}°M → Outbound {norm(m.inboundTrack + 180)}°M</div>}
                      {m.altitude && <div>Alt {m.altitude}ft — leg: {m.altitude / 100 <= 140 ? "1 min" : "1.5 min"}</div>}
                      {m.windDir != null && <div>Wind: {m.windDir}°/{m.windSpd}kt</div>}
                      <div style={{ color: C.textMuted, fontSize: 9, marginTop: 4 }}>
                        Saved {new Date(m.savedAt).toLocaleString("en-AU", { dateStyle: "short", timeStyle: "short" })}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                    <button style={S.btnPrim} onClick={() => loadMemory(k)}>LOAD</button>
                    {deleteConfirm === k
                      ? <><button style={S.btnDanger} onClick={() => delMemory(k)}>CONFIRM</button>
                          <button style={S.btnNeutral} onClick={() => setDeleteConfirm(null)}>CANCEL</button></>
                      : <button style={S.btnDanger} onClick={() => setDeleteConfirm(k)}>DELETE</button>}
                  </div>
                </div>
              );
            })}
          </>
        )}

        {/* ── REFERENCE TAB ── */}
        {/* ── PLATES TAB ── */}
        {tab === "plates" && (
          <PlatesTab onPopulateBrief={(data) => {
            // When plate is ingested, switch to brief tab and populate
            setTab("brief");
            window._plateIngest = data;
            window.dispatchEvent(new CustomEvent("plate-ingested", { detail: data }));
          }} />
        )}

        {/* ── NAVLOG TAB (v3.0) ── */}
        {tab === "navlog" && <NavLogTab aircraft={aircraftHook.active} />}

        {/* ── WEIGHT & BALANCE TAB (v3.0) ── */}
        {tab === "wb" && <WBTab aircraft={aircraftHook.active} />}

        {/* ── PERFORMANCE TAB (v3.0) ── */}
        {tab === "perf" && <PerfTab aircraft={aircraftHook.active} />}

        {/* ── WEATHER (METAR) TAB (v3.0) ── */}
        {tab === "wx" && <WxTab />}

        {/* ── AIRCRAFT PROFILES TAB (v3.0) ── */}
        {tab === "aircraft" && <AircraftTab aircraftHook={aircraftHook} />}

        {tab === "ref" && (
          <>
            <Card>
              <CardTitle icon="◈">AU AIP ENR 1.5 SPEED LIMITS</CardTitle>
              {Object.entries(ICAO_CATS).map(([k, v]) => (
                <div key={k} style={S.refSection}>
                  <div style={S.refTitle}>{v.label} · Vat {v.vatRange}</div>
                  <div style={S.refRow}><span style={{ fontSize: 10.5, color: C.textSub }}>≤ FL140</span><span style={{ fontSize: 10.5, color: C.accent, fontWeight: 600 }}>{v.maxBelow14k} KIAS MAX</span></div>
                  <div style={{ ...S.refRow, borderBottom: "none" }}><span style={{ fontSize: 10.5, color: C.textSub }}>&gt; FL140</span><span style={{ fontSize: 10.5, color: C.accent, fontWeight: 600 }}>{v.maxAbove14k} KIAS MAX</span></div>
                </div>
              ))}
            </Card>
            <Card>
              <CardTitle icon="◈">LEG TIMING</CardTitle>
              <DataRow label="≤ FL140" value="1 MIN outbound" valueColor={C.accent} />
              <DataRow label="> FL140" value="1.5 MIN outbound" valueColor={C.accent} />
              <DataRow label="S2 (offset) max" value="1.5 MIN (overrides chart)" valueColor={C.s2} />
              <div style={S.notesBox}>Timing from ABEAM fix or wings level — whichever is later. (ENR 1.5 para 3.1.2)</div>
            </Card>
            <Card>
              <CardTitle icon="◈">SECTOR DEFINITIONS</CardTitle>
              {[
                { sector: "S1 · PARALLEL", col: C.s1, lines: ["Non-holding side, 180° arc of outbound direction.", "Cross fix → fly parallel to inbound on non-holding side.", "Turn holding-side (>180°) to intercept inbound."] },
                { sector: "S2 · OFFSET", col: C.s2, lines: ["Holding side, within 70° of outbound.", "Cross fix → fly 30° offset toward holding side.", "Max outbound: 1.5 min (even if chart shows 1 min).", "Turn to intercept inbound."] },
                { sector: "S3 · DIRECT", col: C.s3, lines: ["Within 110° of outbound on non-holding side.", "Cross fix → immediately turn holding side.", "Fly outbound, then turn to inbound."] },
              ].map(({ sector: s, col, lines }) => (
                <div key={s} style={{ ...S.refSection, borderColor: col }}>
                  <div style={{ ...S.refTitle, color: col }}>{s}</div>
                  {lines.map((l, i) => <div key={i} style={{ fontSize: 11, color: i === 0 ? C.text : C.textSub, marginBottom: 4 }}>{l}</div>)}
                </div>
              ))}
            </Card>
            <Card>
              <CardTitle icon="◈">ATC PHRASEOLOGY</CardTitle>
              {[
                { label: "Entering hold", text: "[Callsign], entering the hold at [fix], [altitude]." },
                { label: "Expecting further clearance", text: "[Callsign], request EFC time at [fix]." },
                { label: "Unable to hold (speed)", text: "[Callsign], unable to comply with holding speed, request [alternative]." },
                { label: "Leaving hold", text: "[Callsign], leaving the hold at [fix], proceeding [destination/track]." },
                { label: "Request approach", text: "[Callsign], request [approach type] approach runway [XX], [fix]." },
                { label: "Missed approach", text: "[Callsign], going around, [missed approach track], climbing to [altitude]." },
              ].map(({ label, text }) => (
                <div key={label} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 9, letterSpacing: 1.5, color: C.textSub, textTransform: "uppercase", marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: 11, color: C.text, background: C.bg, borderRadius: 5, padding: "8px 10px", fontFamily: "monospace", lineHeight: 1.5 }}>{text}</div>
                </div>
              ))}
            </Card>
            <Card>
              <CardTitle icon="◈">GENERAL RULES</CardTitle>
              <div style={S.notesBox}>
                <div>• Standard hold = RIGHT turns. (ENR 1.5 para 3.1.3)</div>
                <div>• Sector entry = HEADING at fix, not ground track. (para 3.4.1)</div>
                <div>• Bank: standard rate or max 30° (FD: 25°). (para 3.1.6)</div>
                <div>• Obtain inbound track BEFORE crossing fix. (para 3.1.5)</div>
                <div>• Outbound WCA = 3× inbound WCA. (para 3.1.4)</div>
                <div>• DME / RNAV distance may substitute timing where published.</div>
                <div>• Transition altitude AU: 10,000ft · Transition level: FL110 (unless chart states).</div>
              </div>
            </Card>
            <Card>
              <CardTitle icon="◈">TABLE 1.1 APPROACH SPEEDS</CardTitle>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10, fontFamily: "monospace" }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                      {["Cat", "Initial", "Final", "Circling", "Missed"].map(h => (
                        <th key={h} style={{ padding: "6px 4px", color: C.textSub, textAlign: "left", letterSpacing: 1 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[["A","90–150","70–100","100","110"],["B","120–180","85–130","135","150"],["C","160–240","115–160","180","240"],["D","185–250","130–185","205","265"],["E","185–250","155–230","240","275"]].map(([c,...vals]) => (
                      <tr key={c} style={{ borderBottom: `1px solid ${C.border}` }}>
                        <td style={{ padding: "6px 4px", color: C.accent, fontWeight: 700 }}>{c}</td>
                        {vals.map((v, i) => <td key={i} style={{ padding: "6px 4px", color: C.text }}>{v}kt</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}

      </div>
    </div>
  );
}
