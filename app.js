/* ETF Cashflow-Rebalancing Rechner
 * Logik aus der Excel-Vorlage:
 *   Ist-Anteil      = Wert / Summe Werte
 *   Max.-Bestimmung = Wert / Ziel-Anteil
 *   Differenz       = MAX(Max.-Bestimmung) * Ziel-Anteil - Wert   (Cashflow bis Ziel ohne Verkauf)
 *   Neu. Wert       = Wert + Differenz
 *   Ziel-Check      = Neu. Wert / Summe Neu. Werte
 * Monatsplan: Jede Sparrate wird per "Water-Filling" verteilt, sodass die Abweichung
 * zur Zielallokation minimal wird (kein Verkauf, kein zusätzliches Budget).
 */
(() => {
  "use strict";

  const STORAGE_KEY = "cfr-state-v1";
  const THEME_KEY = "cfr-theme";
  const PALETTE = ["#197A56", "#29BA74", "#9ACD32", "#295E7E", "#3EAD92", "#D4A017", "#7A5195", "#6E6E6E"];
  const MAX_SIM = 600;
  const EPS_PP = 0.01; // Toleranz in Prozentpunkten für "Ziel erreicht"

  const DEFAULT_STATE = {
    positions: [
      { name: "MSCI World ETF", value: 25234, target: 60 },
      { name: "MSCI Emerging Markets ETF", value: 12122, target: 30 },
      { name: "MSCI Small Cap ETF", value: 4314, target: 10 },
    ],
    rate: 450,
    horizon: 12,
    roundEuro: true,
  };

  const $ = (sel) => document.querySelector(sel);
  const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const eur2 = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = new Intl.NumberFormat("de-DE", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const pct2 = new Intl.NumberFormat("de-DE", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const num2 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let state = load();

  // ---------- Persistenz ----------
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (Array.isArray(s.positions)) return { ...structuredClone(DEFAULT_STATE), ...s };
      }
    } catch (_) { /* ignore */ }
    return structuredClone(DEFAULT_STATE);
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
  }

  // ---------- Rechenkern ----------
  const toNum = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : 0; };

  /** Ziel-Gewichte normalisiert auf Summe 1. */
  function weightsOf(positions) {
    const t = positions.map((p) => toNum(p.target));
    const s = t.reduce((a, b) => a + b, 0);
    return s > 0 ? t.map((x) => x / s) : t.map(() => 0);
  }

  /** Excel-Logik "Aktuell". */
  function snapshot(values, weights) {
    const total = values.reduce((a, b) => a + b, 0);
    const maxDet = values.map((v, i) => (weights[i] > 0 ? v / weights[i] : null));
    const maxG = Math.max(0, ...maxDet.filter((x) => x !== null));
    const diff = values.map((v, i) => (weights[i] > 0 ? Math.max(0, maxG * weights[i] - v) : 0));
    const newVal = values.map((v, i) => v + diff[i]);
    const newTotal = newVal.reduce((a, b) => a + b, 0);
    return {
      total,
      ist: values.map((v) => (total > 0 ? v / total : 0)),
      maxDet,
      diff,
      gap: diff.reduce((a, b) => a + b, 0),
      newVal,
      newTotal,
      check: newVal.map((v) => (newTotal > 0 ? v / newTotal : 0)),
    };
  }

  /** Optimale Verteilung eines Budgets ohne Verkauf (Water-Filling). */
  function allocate(values, weights, budget) {
    const n = values.length;
    const alloc = new Array(n).fill(0);
    if (budget <= 0) return alloc;
    let active = values.map((_, i) => i).filter((i) => weights[i] > 0);
    if (!active.length) return alloc;
    for (let guard = 0; guard < n + 1; guard++) {
      const pool = active.reduce((a, i) => a + values[i], 0) + budget;
      const wSum = active.reduce((a, i) => a + weights[i], 0);
      const over = active.filter((i) => (weights[i] / wSum) * pool < values[i] - 1e-9);
      if (!over.length) {
        active.forEach((i) => { alloc[i] = (weights[i] / wSum) * pool - values[i]; });
        break;
      }
      active = active.filter((i) => !over.includes(i));
    }
    return alloc;
  }

  /** Rundung auf ganze Euro nach größtem Rest (Summe bleibt gleich). */
  function roundAlloc(alloc, budget) {
    const target = Math.round(budget);
    const floors = alloc.map(Math.floor);
    let rest = target - floors.reduce((a, b) => a + b, 0);
    const order = alloc.map((a, i) => [a - Math.floor(a), i]).sort((x, y) => y[0] - x[0]);
    for (let k = 0; k < order.length && rest > 0; k++, rest--) floors[order[k][1]] += 1;
    return floors;
  }

  const maxDrift = (values, weights) => {
    const t = values.reduce((a, b) => a + b, 0);
    if (t <= 0) return 0;
    return Math.max(0, ...values.map((v, i) => Math.abs(v / t - weights[i]))) * 100;
  };

  function simulate(values, weights, rate, months, round) {
    let cur = values.slice();
    const rows = [];
    let reachedAt = maxDrift(cur, weights) < EPS_PP ? 0 : null;
    const limit = Math.max(months, MAX_SIM);
    for (let m = 1; m <= limit; m++) {
      let a = allocate(cur, weights, rate);
      if (round) a = roundAlloc(a, rate);
      const start = cur;
      cur = cur.map((v, i) => v + a[i]);
      const drift = maxDrift(cur, weights);
      if (reachedAt === null && drift < (round ? 0.05 : EPS_PP)) reachedAt = m;
      if (m <= months) rows.push({ m, start, alloc: a, end: cur, drift });
      if (m >= months && reachedAt !== null) break;
    }
    return { rows, reachedAt };
  }

  // ---------- Rendering ----------
  const colorOf = (i) => PALETTE[i % PALETTE.length];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nameOf = (p, i) => (p.name && p.name.trim()) || `Position ${i + 1}`;

  function renderInputs() {
    const host = $("#positions");
    host.innerHTML = "";
    const tpl = $("#posTpl");
    state.positions.forEach((p, i) => {
      const row = tpl.content.firstElementChild.cloneNode(true);
      row.querySelector(".dot").style.background = colorOf(i);
      const nm = row.querySelector(".in-name");
      const vl = row.querySelector(".in-value");
      const tg = row.querySelector(".in-target");
      nm.value = p.name; vl.value = p.value; tg.value = p.target;
      nm.addEventListener("input", () => { p.name = nm.value; update(); });
      vl.addEventListener("input", () => { p.value = vl.value; update(); });
      tg.addEventListener("input", () => { p.target = tg.value; update(); });
      row.querySelector(".rm").addEventListener("click", () => {
        if (state.positions.length <= 1) return;
        state.positions.splice(i, 1);
        renderInputs(); update();
      });
      host.appendChild(row);
    });
  }

  function update() {
    save();
    const P = state.positions;
    const values = P.map((p) => toNum(p.value));
    const rawTargets = P.map((p) => toNum(p.target));
    const tSum = rawTargets.reduce((a, b) => a + b, 0);
    const weights = weightsOf(P);
    const rate = toNum(state.rate);
    const horizon = Math.min(120, Math.max(1, Math.round(toNum(state.horizon)) || 12));
    const snap = snapshot(values, weights);
    const sim = simulate(values, weights, rate, horizon, !!state.roundEuro);

    // Summenzeile & Warnung
    $("#sumValue").textContent = eur.format(snap.total);
    $("#sumTarget").textContent = num1.format(tSum) + " %";
    $("#sumTarget").style.color = Math.abs(tSum - 100) > 0.05 ? "var(--neg)" : "";
    const warn = $("#targetWarn");
    if (Math.abs(tSum - 100) > 0.05 && tSum > 0) {
      warn.hidden = false;
      warn.textContent = `Ziel-Anteile ergeben ${num1.format(tSum)} % statt 100 % – für die Berechnung werden sie proportional normalisiert.`;
    } else warn.hidden = true;

    // KPIs
    const drift0 = maxDrift(values, weights);
    $("#kpiTotal").textContent = eur.format(snap.total);
    $("#kpiGap").textContent = eur.format(snap.gap);
    const km = $("#kpiMonths");
    if (sim.reachedAt === 0) { km.textContent = "Erreicht"; km.classList.add("good"); }
    else if (sim.reachedAt) { km.textContent = `${sim.reachedAt} ${sim.reachedAt === 1 ? "Monat" : "Monaten"}`; km.classList.remove("good"); }
    else { km.textContent = rate > 0 ? "> 50 Jahre" : "–"; km.classList.remove("good"); }
    $("#kpiMonthsSub").textContent = rate > 0 ? `bei ${eur.format(rate)} / Monat` : "Sparrate eingeben";
    $("#kpiDrift").textContent = num2.format(drift0);

    renderAlloc(P, snap, weights);
    renderCurrent(P, snap, weights, sim);
    renderPlan(P, weights, sim, rate);
    renderMonthCards(P, sim);
  }

  function deltaBadge(pp) {
    const cls = Math.abs(pp) < 0.05 ? "zero" : pp > 0 ? "neg" : "pos";
    const sign = pp > 0 ? "+" : pp < 0 ? "−" : "±";
    return `<span class="delta ${cls}">${sign}${num1.format(Math.abs(pp))} pp</span>`;
  }

  function renderAlloc(P, snap, weights) {
    const maxScale = Math.max(0.01, ...snap.ist, ...weights) * 1.15;
    const host = $("#allocChart");
    host.innerHTML = P.map((p, i) => {
      const pp = (snap.ist[i] - weights[i]) * 100;
      return `<div class="alloc-row">
        <div class="alloc-name"><i class="dot" style="background:${colorOf(i)}"></i><span>${esc(nameOf(p, i))}</span></div>
        <div class="alloc-track">
          <div class="alloc-fill" style="width:${(snap.ist[i] / maxScale) * 100}%;background:${colorOf(i)}"></div>
          <div class="alloc-target" style="left:${(weights[i] / maxScale) * 100}%" data-label="Ziel ${pct.format(weights[i])}"></div>
        </div>
        <div class="alloc-meta"><b>${pct.format(snap.ist[i])}</b>${deltaBadge(pp)}</div>
      </div>`;
    }).join("");

    // Action-Title im Beratungsstil
    let worst = -1, worstPP = 0;
    snap.ist.forEach((s, i) => { const pp = (s - weights[i]) * 100; if (pp < worstPP) { worstPP = pp; worst = i; } });
    $("#allocTitle").textContent = worst >= 0 && Math.abs(worstPP) >= 0.05
      ? `${nameOf(P[worst], worst)} ist mit ${pct.format(snap.ist[worst])} um ${num1.format(-worstPP)} pp untergewichtet`
      : "Das Depot entspricht bereits der Zielallokation";
  }

  function renderCurrent(P, snap, weights, sim) {
    const first = sim.rows[0];
    const head = `<thead><tr>
      <th>ETF / Position</th><th>Monatl. Invest (M1)</th><th>Akt. Wert</th><th>Ist-Anteil</th><th>Ziel-Anteil</th>
      <th>Max.-Bestimmung</th><th>Differenz</th><th>Neu. Wert</th><th>Ziel-Check</th></tr></thead>`;
    const body = P.map((p, i) => `<tr>
      <td><span class="cell-name"><i class="dot" style="background:${colorOf(i)}"></i>${esc(nameOf(p, i))}</span></td>
      <td>${first ? eur2.format(first.alloc[i]) : "–"}</td>
      <td>${eur2.format(toNum(p.value))}</td>
      <td>${pct2.format(snap.ist[i])}</td>
      <td>${pct2.format(weights[i])}</td>
      <td class="muted">${snap.maxDet[i] === null ? "–" : eur2.format(snap.maxDet[i])}</td>
      <td class="${snap.diff[i] > 0.005 ? "hl" : "muted"}">${eur2.format(snap.diff[i])}</td>
      <td>${eur2.format(snap.newVal[i])}</td>
      <td>${pct2.format(snap.check[i])}</td>
    </tr>`).join("");
    const sumFirst = first ? first.alloc.reduce((a, b) => a + b, 0) : 0;
    const foot = `<tfoot><tr><td>Gesamt</td><td>${eur2.format(sumFirst)}</td><td>${eur2.format(snap.total)}</td>
      <td>${pct2.format(snap.total > 0 ? 1 : 0)}</td><td>${pct2.format(weights.reduce((a, b) => a + b, 0))}</td><td></td>
      <td class="hl">${eur2.format(snap.gap)}</td><td>${eur2.format(snap.newTotal)}</td>
      <td>${pct2.format(snap.check.reduce((a, b) => a + b, 0))}</td></tr></tfoot>`;
    $("#currentTable").innerHTML = head + `<tbody>${body}</tbody>` + foot;
  }

  function renderPlan(P, weights, sim, rate) {
    const rows = sim.rows;
    $("#planTitle").textContent = rate <= 0
      ? "Monatliche Sparraten-Verteilung"
      : sim.reachedAt === 0
        ? `Depot ist balanciert – ${eur.format(rate)} pro Monat werden nach Zielquote verteilt`
        : sim.reachedAt
          ? `Mit ${eur.format(rate)} pro Monat ist die Zielallokation nach ${sim.reachedAt} ${sim.reachedAt === 1 ? "Monat" : "Monaten"} erreicht`
          : `Mit ${eur.format(rate)} pro Monat wird die Zielallokation im betrachteten Zeitraum nicht erreicht`;

    // Legende
    $("#planLegend").innerHTML = P.map((p, i) => `<span><i class="lg-sw" style="background:${colorOf(i)}"></i>${esc(nameOf(p, i))}</span>`).join("")
      + `<span><i class="lg-tick" style="background:var(--ink);width:14px;height:2px"></i>Max. Abweichung (pp)</span>`;

    // Chart (SVG)
    const W = 1000, H = 300, padL = 56, padR = 56, padT = 20, padB = 34;
    const iw = W - padL - padR, ih = H - padT - padB;
    const n = rows.length;
    const maxBar = Math.max(1, ...rows.map((r) => r.alloc.reduce((a, b) => a + b, 0)));
    const drift0 = maxDrift(rows.length ? rows[0].start : [], weights);
    const maxD = Math.max(0.1, drift0, ...rows.map((r) => r.drift));
    const bw = Math.min(56, (iw / Math.max(n, 1)) * 0.62);
    const x = (k) => padL + (iw / n) * (k + 0.5);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monatliche Investitionen je Position und Abweichung zum Ziel">`;
    for (let g = 0; g <= 4; g++) {
      const y = padT + ih - (ih * g) / 4;
      svg += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/>`;
      svg += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end">${eur.format((maxBar * g) / 4)}</text>`;
      svg += `<text x="${W - padR + 8}" y="${y + 4}">${num1.format((maxD * g) / 4)}</text>`;
    }
    rows.forEach((r, k) => {
      let yAcc = padT + ih;
      r.alloc.forEach((a, i) => {
        if (a <= 0) return;
        const h = (a / maxBar) * ih;
        yAcc -= h;
        svg += `<rect x="${x(k) - bw / 2}" y="${yAcc}" width="${bw}" height="${Math.max(0, h - 1)}" fill="${colorOf(i)}" rx="2"><title>Monat ${r.m} · ${esc(nameOf(P[i], i))}: ${eur2.format(a)}</title></rect>`;
      });
      if (n <= 24 || k % Math.ceil(n / 24) === 0) svg += `<text x="${x(k)}" y="${H - 12}" text-anchor="middle"${sim.reachedAt === r.m ? ' class="lbl-strong"' : ""}>M${r.m}</text>`;
    });
    if (n) {
      const yD = (d) => padT + ih - (d / maxD) * ih;
      const pts = rows.map((r, k) => `${x(k)},${yD(r.drift)}`).join(" ");
      svg += `<polyline class="drift" points="${padL},${yD(drift0)} ${pts}"/>`;
      rows.forEach((r, k) => { svg += `<circle class="drift-dot" cx="${x(k)}" cy="${yD(r.drift)}" r="3.5"><title>Monat ${r.m}: ${num2.format(r.drift)} pp</title></circle>`; });
    }
    svg += `<line class="axis" x1="${padL}" x2="${W - padR}" y1="${padT + ih}" y2="${padT + ih}"/></svg>`;
    $("#planChart").innerHTML = svg;

    // Tabelle
    const head = `<thead><tr><th>Monat</th>${P.map((p, i) => `<th><span class="cell-name"><i class="dot" style="background:${colorOf(i)}"></i>${esc(nameOf(p, i))}</span></th>`).join("")}<th>Summe</th><th>Depotwert danach</th><th>Max. Abw.</th></tr></thead>`;
    const body = rows.map((r) => {
      const tot = r.end.reduce((a, b) => a + b, 0);
      return `<tr class="${sim.reachedAt === r.m ? "reached" : ""}"><td>Monat ${r.m}${sim.reachedAt === r.m ? " ✓" : ""}</td>
        ${r.alloc.map((a) => `<td class="${a > 0 ? "" : "muted"}">${eur2.format(a)}</td>`).join("")}
        <td><b>${eur2.format(r.alloc.reduce((a, b) => a + b, 0))}</b></td><td>${eur2.format(tot)}</td><td>${num2.format(r.drift)} pp</td></tr>`;
    }).join("");
    $("#planTable").innerHTML = head + `<tbody>${body}</tbody>`;
  }

  function renderMonthCards(P, sim) {
    const rows = sim.rows.slice(0, Math.min(sim.rows.length, 6));
    $("#monthCards").innerHTML = rows.map((r) => {
      const tot = r.end.reduce((a, b) => a + b, 0);
      return `<div class="mcard ${sim.reachedAt === r.m ? "reached" : ""}">
        <h3>Monat ${r.m}${sim.reachedAt === r.m ? '<span class="tag">Ziel erreicht</span>' : ""}</h3>
        <div class="mtotal">${eur.format(r.alloc.reduce((a, b) => a + b, 0))}</div>
        <ul>${r.alloc.map((a, i) => `<li><span><i class="dot" style="background:${colorOf(i)}"></i>${esc(nameOf(P[i], i))}</span><b>${eur2.format(a)}</b></li>`).join("")}
        <li class="shares"><span>Anteile</span><b>${r.end.map((v) => num1.format(tot > 0 ? (v / tot) * 100 : 0)).join(" / ")} %</b></li></ul>
      </div>`;
    }).join("");
  }

  function exportCSV() {
    const P = state.positions;
    const values = P.map((p) => toNum(p.value));
    const weights = weightsOf(P);
    const horizon = Math.min(120, Math.max(1, Math.round(toNum(state.horizon)) || 12));
    const sim = simulate(values, weights, toNum(state.rate), horizon, !!state.roundEuro);
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const f = (n) => n.toFixed(2).replace(".", ",");
    const lines = [["Monat", ...P.map((p, i) => nameOf(p, i)), "Summe", "Depotwert danach", "Max. Abweichung (pp)"].map(q).join(";")];
    sim.rows.forEach((r) => {
      lines.push([r.m, ...r.alloc.map(f), f(r.alloc.reduce((a, b) => a + b, 0)), f(r.end.reduce((a, b) => a + b, 0)), f(r.drift)].join(";"));
    });
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "rebalancing-sparplan.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- Theme ----------
  function initTheme() {
    let t = null;
    try { t = localStorage.getItem(THEME_KEY); } catch (_) { /* ignore */ }
    if (t) document.documentElement.dataset.theme = t;
    $("#themeToggle").addEventListener("click", () => {
      const cur = document.documentElement.dataset.theme
        || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* ignore */ }
    });
  }

  // ---------- Init ----------
  function bindControls() {
    const rate = $("#rate"), hz = $("#horizon"), rd = $("#roundEuro");
    rate.value = state.rate; hz.value = state.horizon; rd.checked = !!state.roundEuro;
    rate.addEventListener("input", () => { state.rate = rate.value; update(); });
    hz.addEventListener("input", () => { state.horizon = hz.value; update(); });
    rd.addEventListener("change", () => { state.roundEuro = rd.checked; update(); });
    $("#addBtn").addEventListener("click", () => {
      state.positions.push({ name: "", value: 0, target: 0 });
      renderInputs(); update();
      const inputs = document.querySelectorAll(".in-name");
      inputs[inputs.length - 1].focus();
    });
    $("#resetBtn").addEventListener("click", () => {
      state = structuredClone(DEFAULT_STATE);
      bindValues(); renderInputs(); update();
    });
    $("#csvBtn").addEventListener("click", exportCSV);
  }
  function bindValues() {
    $("#rate").value = state.rate; $("#horizon").value = state.horizon; $("#roundEuro").checked = !!state.roundEuro;
  }

  initTheme();
  bindControls();
  renderInputs();
  update();
})();
