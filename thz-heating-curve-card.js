/**
 * thz-heating-curve-card.js
 *
 * A Lovelace custom card for the `thz` Stiebel Eltron / Tecalor LWZ/THZ
 * integration. Plots the weather-compensated HC1 flow-temperature curve
 * (from the live p13Gradient / p14LowEnd / p15RoomInfluence parameters)
 * and drops a marker at the device's actual current outside-temp /
 * heat_set_temp reading, so you can see at a glance how far real behaviour
 * has drifted from the theoretical curve before adjusting a parameter.
 *
 * The curve formula is ported from the FHEM THZ.pm project's
 * `function_heatSetTemp`, which reverse-engineered it from real device
 * behaviour -- it is not an official Stiebel Eltron formula, but the best
 * verified approximation publicly available. See docs/legacy/00_THZ.pm in
 * the lwz-thz-403 repo for the original Perl.
 *
 * --- Example Lovelace card config -----------------------------------
 * type: custom:thz-heating-curve-card
 * title: HC1 Heating Curve
 * font_size: 15        # px, scales the card's text (title/legend/stats/fields); default 15
 * axis_font_size: 11   # SVG-space units, scales the chart's axis tick labels; default 11
 * entities:
 *   gradient: number.lwz403_p13_gradient_hc1
 *   low_end: number.lwz403_p14_low_end_hc1
 *   room_influence: number.lwz403_p15_room_influence_hc1
 *   room_set: climate.lwz403_heating_circuit   # reads target_temperature
 *   inside_temp: sensor.lwz403_inside_temp
 *   outside_temp: sensor.lwz403_outside_temp_filtered
 *   heat_set_temp: sensor.lwz403_heat_set_temp
 * step:               # fallback spinner increment, only used when the
 *   gradient: 0.05     # number entity itself has no min/max/step attrs
 *   low_end: 0.5
 *   room_influence: 5
 * -----------------------------------------------------------------------
 */

const DEFAULT_ENTITIES = {
  gradient: "number.lwz403_p13_gradient_hc1",
  low_end: "number.lwz403_p14_low_end_hc1",
  room_influence: "number.lwz403_p15_room_influence_hc1",
  room_set: "climate.lwz403_heating_circuit",
  inside_temp: "sensor.lwz403_inside_temp",
  outside_temp: "sensor.lwz403_outside_temp_filtered",
  heat_set_temp: "sensor.lwz403_heat_set_temp",
};

const DEFAULT_STEP = { gradient: 0.05, low_end: 0.5, room_influence: 5 };
const DEFAULT_FONT_SIZE = 15;
const DEFAULT_AXIS_FONT_SIZE = 11;

const PARAM_DEFS = [
  { key: "gradient", label: "Gradient (P13)", digits: 2 },
  { key: "low_end", label: "Low end (P14)", digits: 1 },
  { key: "room_influence", label: "Room influence (P15)", digits: 0 },
];

const X_MIN = -20, X_MAX = 25;
const W = 620, H = 300;
const X_GRID_STEP = 5;

function curveValue(T, gradient, lowEnd, roomInf, roomSet, inside, withRoom) {
  const roomTerm = withRoom ? (roomInf * gradient * (roomSet - inside)) / 10 : 0;
  const a = 0.7 + roomSet * (1 + gradient * 0.87) + lowEnd + roomTerm;
  const b = (-14 * gradient) / roomSet;
  const c = (-1 * gradient) / 75;
  return Math.max(5, c * T * T + b * T + a);
}

function niceStep(range) {
  if (range <= 20) return 5;
  if (range <= 40) return 10;
  return 20;
}

function fmt(v, d = 1) {
  return typeof v === "number" && !Number.isNaN(v) ? v.toFixed(d) : "--";
}

class THZHeatingCurveCard extends HTMLElement {
  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    this._config = config;
    this._entities = { ...DEFAULT_ENTITIES, ...(config.entities || {}) };
    this._step = { ...DEFAULT_STEP, ...(config.step || config.nudge_step || {}) };
    this._title = config.title || "Heating Curve";
    this._fontSize = Number(config.font_size) > 0 ? Number(config.font_size) : DEFAULT_FONT_SIZE;
    this._axisFontSize = Number(config.axis_font_size) > 0 ? Number(config.axis_font_size) : DEFAULT_AXIS_FONT_SIZE;

    // Chart padding (in SVG viewBox units) grows with the axis font size so
    // bigger tick labels never clip against the plot area or the card edge.
    this._pad = {
      l: Math.round(34 + this._axisFontSize * 1.6),
      r: 18,
      t: Math.round(10 + this._axisFontSize * 0.4),
      b: Math.round(18 + this._axisFontSize * 1.6),
    };
    this._plotW = W - this._pad.l - this._pad.r;
    this._plotH = H - this._pad.t - this._pad.b;

    this._chartState = null;
    this._lastPointer = null;

    // Unsaved parameter edits, keyed by PARAM_DEFS key (e.g. "gradient").
    // Populated as the user types, cleared on Apply/Discard, or when a field
    // is emptied out. Never written to the device until Apply is clicked.
    this._pending = {};
    this._applying = false;
    this._applyError = null;

    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._buildStaticDom();
  }

  getCardSize() {
    return 6;
  }

  static getStubConfig() {
    return { type: "custom:thz-heating-curve-card", title: "HC1 Heating Curve", entities: DEFAULT_ENTITIES };
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _num(entityId, attr) {
    const st = this._hass && this._hass.states[entityId];
    if (!st) return null;
    const raw = attr ? st.attributes[attr] : st.state;
    const v = parseFloat(raw);
    return Number.isNaN(v) ? null : v;
  }

  _meta(entityId) {
    const st = this._hass && this._hass.states[entityId];
    const a = (st && st.attributes) || {};
    return { min: a.min, max: a.max, step: a.step };
  }

  _buildStaticDom() {
    const root = this.shadowRoot;
    root.innerHTML = `
      <style>
        :host {
          display: block;
          font-size: ${this._fontSize}px;
          --axis-font-size: ${this._axisFontSize}px;
        }
        ha-card { padding: 16px 16px 10px; }
        .head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
        .head h1 { font-size: 1.25em; font-weight: 600; margin: 0; color: var(--primary-text-color); }
        .preview-badge {
          display: none; align-items: center; gap: 5px; font-size: 0.8em; font-weight: 600;
          color: #f0c14b; text-transform: uppercase; letter-spacing: .04em;
        }
        .preview-badge .dot {
          width: 7px; height: 7px; border-radius: 50%; background: #f0c14b;
          box-shadow: 0 0 0 3px rgba(240,193,75,0.25);
        }
        .legend { display: flex; gap: 12px; font-size: 0.85em; color: var(--secondary-text-color); }
        .legend span.sw { display:inline-block; width:10px; height:2px; margin-right:4px; vertical-align:middle; }
        svg { display: block; width: 100%; height: auto; }
        .grid { stroke: var(--divider-color, #444); stroke-width: 1; opacity: 0.5; }
        .grid.strong { opacity: 0.9; }
        .axis { fill: var(--secondary-text-color); font-size: var(--axis-font-size); font-family: var(--paper-font-common-base_-_font-family, inherit); }
        .curve-a { stroke: #cf6f34; stroke-width: 2.25; fill: none; stroke-linecap: round; transition: opacity 0.15s ease; }
        .curve-b { stroke: #149bb0; stroke-width: 1.75; fill: none; stroke-linecap: round; stroke-dasharray: 1 5; transition: opacity 0.15s ease; }
        /* The currently-applied curve, stepped back once a preview is showing. */
        .curve-dim { opacity: 0.28; }
        /* The unsaved preview curve: same colours, drawn brighter/bolder and
           on top so it reads as "this is what you're about to apply". */
        .curve-preview { opacity: 1; filter: saturate(1.35) brightness(1.15); }
        .curve-preview.curve-a { stroke-width: 3; }
        .curve-preview.curve-b { stroke-width: 2.25; }
        .marker-ring { fill: rgba(240,193,75,0.20); stroke: none; }
        .marker-dot { fill: #f0c14b; stroke: var(--card-background-color, #1c1c1c); stroke-width: 2; }
        .marker-vline { stroke: #f0c14b; stroke-width: 1; stroke-dasharray: 2 3; opacity: 0.7; }
        .hover-crosshair { pointer-events: none; }
        .hover-vline, .hover-hline { stroke: var(--secondary-text-color); stroke-width: 1; stroke-dasharray: 2 3; opacity: 0.85; }
        .hover-dot { fill: var(--primary-text-color); }
        .hover-label {
          fill: var(--primary-text-color); font-size: var(--axis-font-size); font-weight: 600;
          font-family: var(--paper-font-common-base_-_font-family, inherit);
          paint-order: stroke; stroke: var(--card-background-color, #1c1c1c); stroke-width: 3px; stroke-linejoin: round;
        }
        .hover-capture { fill: transparent; cursor: crosshair; }
        .stats { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 6px; padding-top: 10px; border-top: 1px solid var(--divider-color); }
        .stat { display: flex; flex-direction: column; gap: 1px; }
        .stat .l { font-size: 0.8em; text-transform: uppercase; letter-spacing: .05em; color: var(--secondary-text-color); }
        .stat .v { font-size: 1.1em; font-weight: 600; color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
        .stat .v.warn { color: #d68a1c; }
        .params { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
        .param-row { display: flex; align-items: center; gap: 10px; }
        .param-row .name { flex: 1; font-size: 1em; color: var(--primary-text-color); }
        .param-row input[type="number"] {
          width: 6.5em; font-size: 1em; font-weight: 600; text-align: right;
          font-variant-numeric: tabular-nums; padding: 5px 7px; border-radius: 6px;
          border: 1px solid var(--divider-color); background: var(--card-background-color);
          color: var(--primary-text-color); font-family: inherit;
        }
        .param-row input[type="number"]:focus {
          outline: 2px solid var(--primary-color, #03a9f4); outline-offset: -1px;
        }
        .param-row input[type="number"]:disabled { opacity: 0.5; }
        .unavailable { color: var(--secondary-text-color); font-size: 0.95em; padding: 8px 0; }
        .apply-bar {
          display: none; align-items: center; gap: 10px; flex-wrap: wrap;
          margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--divider-color);
        }
        .apply-bar .msg { flex: 1; min-width: 180px; font-size: 0.9em; color: var(--secondary-text-color); }
        .apply-bar .msg b { color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
        .apply-bar .error { flex-basis: 100%; font-size: 0.85em; color: #d68a1c; }
        .apply-bar button {
          font: inherit; font-weight: 600; font-size: 0.9em; border-radius: 8px;
          padding: 7px 16px; cursor: pointer; border: 1px solid transparent;
        }
        .apply-bar button:disabled { opacity: 0.55; cursor: default; }
        .apply-bar .btn-discard {
          background: transparent; border-color: var(--divider-color); color: var(--primary-text-color);
        }
        .apply-bar .btn-apply {
          background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff);
        }
      </style>
      <ha-card>
        <div class="head">
          <h1></h1>
          <span class="preview-badge"><span class="dot"></span>Unsaved preview</span>
          <div class="legend">
            <span><span class="sw" style="background:#cf6f34"></span>with room infl.</span>
            <span><span class="sw" style="background:#149bb0"></span>simplified</span>
          </div>
        </div>
        <div class="chart-slot"></div>
        <div class="stats"></div>
        <div class="params"></div>
        <div class="apply-bar">
          <span class="msg"></span>
          <span class="error"></span>
          <button type="button" class="btn-discard">Discard</button>
          <button type="button" class="btn-apply">Apply</button>
        </div>
      </ha-card>
    `;
    root.querySelector("h1").textContent = this._title;
    root.querySelector(".btn-discard").addEventListener("click", () => this._onDiscard());
    root.querySelector(".btn-apply").addEventListener("click", () => this._onApply());
    this._buildParamRows();
  }

  _buildParamRows() {
    const root = this.shadowRoot;
    const paramsSlot = root.querySelector(".params");
    paramsSlot.innerHTML = "";
    this._paramEls = {};
    for (const p of PARAM_DEFS) {
      const row = document.createElement("div");
      row.className = "param-row";

      const nameSpan = document.createElement("span");
      nameSpan.className = "name";
      nameSpan.textContent = p.label;

      const input = document.createElement("input");
      input.type = "number";
      input.inputMode = "decimal";
      input.setAttribute("aria-label", p.label);
      input.addEventListener("input", () => this._onParamInput(p.key, input));
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") input.blur();
      });

      row.appendChild(nameSpan);
      row.appendChild(input);
      paramsSlot.appendChild(row);
      this._paramEls[p.key] = input;
    }
  }

  // Fires on every keystroke. Never touches the device -- just records the
  // typed value as a pending edit and redraws the chart so the (dimmed)
  // currently-applied curve and the (bright) preview curve can be compared
  // side by side. Nothing reaches the LWZ until Apply is clicked.
  _onParamInput(key, input) {
    const raw = input.value.trim();
    if (raw === "") {
      delete this._pending[key];
    } else {
      const v = parseFloat(raw);
      // Leave the previous pending value (if any) in place while the user is
      // mid-way through typing something not yet a valid number (e.g. "-"
      // or "1."), rather than dropping their edit.
      if (!Number.isNaN(v)) this._pending[key] = v;
    }
    this._render();
  }

  // True when `key`'s pending edit differs from the live device value at
  // the precision the field displays it with -- so retyping the same value
  // (or floating-point noise from the device's own reported state) never
  // shows as a false "unsaved change".
  _isDirty(key, digits) {
    if (!(key in this._pending) || !this._live) return false;
    const live = this._live[key];
    if (live === null || live === undefined) return true;
    return fmt(this._pending[key], digits) !== fmt(live, digits);
  }

  _dirtyKeys() {
    return PARAM_DEFS.filter((p) => this._isDirty(p.key, p.digits)).map((p) => p.key);
  }

  _onDiscard() {
    this._pending = {};
    this._applyError = null;
    this._render();
  }

  async _onApply() {
    const dirty = this._dirtyKeys();
    if (!dirty.length || !this._hass || this._applying) return;
    this._applying = true;
    this._applyError = null;
    this._render();
    try {
      await Promise.all(
        dirty.map((key) => {
          const entityId = this._entities[key];
          let v = this._pending[key];
          const meta = this._meta(entityId);
          if (typeof meta.min === "number") v = Math.max(meta.min, v);
          if (typeof meta.max === "number") v = Math.min(meta.max, v);
          return this._hass.callService("number", "set_value", { entity_id: entityId, value: v });
        })
      );
      for (const key of dirty) delete this._pending[key];
    } catch (err) {
      this._applyError = "Could not apply changes -- see the browser console for details.";
      console.error("thz-heating-curve-card: apply failed", err); // eslint-disable-line no-console
    } finally {
      this._applying = false;
      this._render();
    }
  }

  _svgSkeleton(yMin, yMax, step) {
    const pad = this._pad;
    let grid = "";
    for (let v = yMin; v <= yMax; v += step) {
      const y = pad.t + (1 - (v - yMin) / (yMax - yMin)) * this._plotH;
      grid += `<line class="grid${v === 0 ? " strong" : ""}" x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}"/>`;
      grid += `<text class="axis" x="${pad.l - 8}" y="${y + this._axisFontSize * 0.32}" text-anchor="end">${v}</text>`;
    }
    for (let t = Math.ceil(X_MIN / X_GRID_STEP) * X_GRID_STEP; t <= X_MAX; t += X_GRID_STEP) {
      const x = pad.l + ((t - X_MIN) / (X_MAX - X_MIN)) * this._plotW;
      grid += `<line class="grid${t === 0 ? " strong" : ""}" x1="${x}" y1="${pad.t}" x2="${x}" y2="${H - pad.b}"/>`;
      grid += `<text class="axis" x="${x}" y="${H - 8}" text-anchor="middle">${t}°</text>`;
    }
    return grid;
  }

  _render() {
    const root = this.shadowRoot;
    if (!root || !this._hass) return;
    const e = this._entities;
    const pad = this._pad;

    const gradient = this._num(e.gradient);
    const lowEnd = this._num(e.low_end);
    const roomInf = this._num(e.room_influence);
    const roomSetEntity = this._hass.states[e.room_set];
    const roomSet = roomSetEntity
      ? (e.room_set.startsWith("climate.")
          ? parseFloat(roomSetEntity.attributes.temperature)
          : parseFloat(roomSetEntity.state))
      : null;
    const inside = this._num(e.inside_temp);
    const outsideNow = this._num(e.outside_temp);
    const flowNow = this._num(e.heat_set_temp);

    // Live (currently-applied) values, used by _isDirty() to tell an actual
    // edit apart from the field simply echoing back what's already set.
    this._live = { gradient, low_end: lowEnd, room_influence: roomInf };

    const missing = [
      ["gradient", gradient], ["low_end", lowEnd], ["room_influence", roomInf],
      ["room_set", roomSet], ["inside_temp", inside],
    ].filter(([, v]) => v === null || Number.isNaN(v)).map(([k]) => k);

    const chartSlot = root.querySelector(".chart-slot");
    const statsSlot = root.querySelector(".stats");
    const dirtyKeys = missing.length ? [] : this._dirtyKeys();
    const isDirty = dirtyKeys.length > 0;

    if (missing.length) {
      chartSlot.innerHTML = `<div class="unavailable">Waiting on: ${missing.map((k) => e[k]).join(", ")}</div>`;
      statsSlot.innerHTML = "";
      this._chartState = null;
    } else {
      // Preview values: the pending (unsaved) edit for a dirty key, the live
      // device value for everything else.
      const pGradient = dirtyKeys.includes("gradient") ? this._pending.gradient : gradient;
      const pLowEnd = dirtyKeys.includes("low_end") ? this._pending.low_end : lowEnd;
      const pRoomInf = dirtyKeys.includes("room_influence") ? this._pending.room_influence : roomInf;

      const N = 70;
      const ptsA = [], ptsB = [], ptsA2 = [], ptsB2 = [];
      let yMin = Infinity, yMax = -Infinity;
      for (let i = 0; i <= N; i++) {
        const T = X_MIN + ((X_MAX - X_MIN) * i) / N;
        const vA = curveValue(T, gradient, lowEnd, roomInf, roomSet, inside, true);
        const vB = curveValue(T, gradient, lowEnd, roomInf, roomSet, inside, false);
        ptsA.push([T, vA]); ptsB.push([T, vB]);
        yMin = Math.min(yMin, vA, vB); yMax = Math.max(yMax, vA, vB);
        if (isDirty) {
          const vA2 = curveValue(T, pGradient, pLowEnd, pRoomInf, roomSet, inside, true);
          const vB2 = curveValue(T, pGradient, pLowEnd, pRoomInf, roomSet, inside, false);
          ptsA2.push([T, vA2]); ptsB2.push([T, vB2]);
          yMin = Math.min(yMin, vA2, vB2); yMax = Math.max(yMax, vA2, vB2);
        }
      }
      if (flowNow !== null) { yMin = Math.min(yMin, flowNow); yMax = Math.max(yMax, flowNow); }
      const step = niceStep(yMax - yMin);
      let yLo = Math.max(0, Math.floor((yMin - step * 0.6) / step) * step);
      let yHi = Math.ceil((yMax + step * 0.6) / step) * step;
      if (yHi - yLo < step * 3) yHi = yLo + step * 4;

      const xToPx = (t) => pad.l + ((t - X_MIN) / (X_MAX - X_MIN)) * this._plotW;
      const yToPx = (v) => pad.t + (1 - (v - yLo) / (yHi - yLo)) * this._plotH;
      const toPath = (pts) => "M " + pts.map(([t, v]) => `${xToPx(t).toFixed(1)},${yToPx(v).toFixed(1)}`).join(" L ");

      const pathA = toPath(ptsA);
      const pathB = toPath(ptsB);
      // Once there's an unsaved edit, the currently-applied curve steps back
      // (dimmed, via CSS opacity) so the bright preview curve -- computed
      // from what's actually typed in the fields right now -- reads as the
      // "new" one being proposed. Nothing here has touched the device yet.
      const previewSvg = isDirty
        ? `<path class="curve-b curve-preview" d="${toPath(ptsB2)}"></path><path class="curve-a curve-preview" d="${toPath(ptsA2)}"></path>`
        : "";

      let markerSvg = "";
      let deltaHtml = "";
      if (outsideNow !== null && flowNow !== null) {
        const mx = xToPx(Math.max(X_MIN, Math.min(X_MAX, outsideNow)));
        const my = yToPx(Math.max(yLo, Math.min(yHi, flowNow)));
        markerSvg = `<line class="marker-vline" x1="${mx}" y1="${my}" x2="${mx}" y2="${H - pad.b}"/><circle class="marker-ring" cx="${mx}" cy="${my}" r="11"/><circle class="marker-dot" cx="${mx}" cy="${my}" r="4.5"/>`;
        const expected = curveValue(outsideNow, gradient, lowEnd, roomInf, roomSet, inside, true);
        const delta = flowNow - expected;
        deltaHtml = `
          <div class="stat"><span class="l">Outside</span><span class="v">${fmt(outsideNow)}&deg;C</span></div>
          <div class="stat"><span class="l">Curve says</span><span class="v">${fmt(expected)}&deg;C</span></div>
          <div class="stat"><span class="l">Device reads</span><span class="v">${fmt(flowNow)}&deg;C</span></div>
          <div class="stat"><span class="l">Difference</span><span class="v${Math.abs(delta) >= 1.5 ? " warn" : ""}">${delta >= 0 ? "+" : ""}${fmt(delta)} K</span></div>
        `;
        if (isDirty) {
          const previewExpected = curveValue(outsideNow, pGradient, pLowEnd, pRoomInf, roomSet, inside, true);
          const previewDelta = previewExpected - expected;
          deltaHtml += `
            <div class="stat"><span class="l">Preview says</span><span class="v">${fmt(previewExpected)}&deg;C<span style="color:var(--secondary-text-color); font-weight:400;"> (${previewDelta >= 0 ? "+" : ""}${fmt(previewDelta)} K)</span></span></div>
          `;
        }
      }

      chartSlot.innerHTML = `
        <svg viewBox="0 0 ${W} ${H}">
          <g>${this._svgSkeleton(yLo, yHi, step)}</g>
          <path class="curve-b${isDirty ? " curve-dim" : ""}" d="${pathB}"></path>
          <path class="curve-a${isDirty ? " curve-dim" : ""}" d="${pathA}"></path>
          ${previewSvg}
          ${markerSvg}
          <g class="hover-crosshair" style="display:none">
            <line class="hover-vline" x1="0" y1="0" x2="0" y2="0"/>
            <line class="hover-hline" x1="0" y1="0" x2="0" y2="0"/>
            <circle class="hover-dot" r="3.5"/>
            <text class="hover-label"></text>
          </g>
          <rect class="hover-capture" x="${pad.l}" y="${pad.t}" width="${this._plotW}" height="${this._plotH}"/>
        </svg>
      `;
      statsSlot.innerHTML = deltaHtml;

      // Hover crosshair always follows the preview curve when one is shown,
      // since that's the curve the user is actively shaping.
      this._chartState = {
        pad, plotW: this._plotW, plotH: this._plotH, yLo, yHi,
        gradient: pGradient, lowEnd: pLowEnd, roomInf: pRoomInf, roomSet, inside,
      };
      this._wireHover(chartSlot);
    }

    root.querySelector(".preview-badge").style.display = isDirty ? "inline-flex" : "none";
    this._syncParamInputs({ gradient, low_end: lowEnd, room_influence: roomInf });
    this._syncApplyBar(dirtyKeys);
  }

  _syncParamInputs(liveValues) {
    const root = this.shadowRoot;
    const activeEl = root.activeElement;
    const e = this._entities;
    for (const p of PARAM_DEFS) {
      const input = this._paramEls[p.key];
      const entityId = e[p.key];
      const meta = this._meta(entityId);
      const value = liveValues[p.key];

      if (typeof meta.min === "number") input.min = String(meta.min); else input.removeAttribute("min");
      if (typeof meta.max === "number") input.max = String(meta.max); else input.removeAttribute("max");
      input.step = String(typeof meta.step === "number" ? meta.step : (this._step[p.key] ?? 1));
      input.disabled = value === null;

      // Never overwrite a field the user is actively editing, nor one that
      // holds an unapplied edit -- otherwise an unrelated entity updating
      // elsewhere (which re-renders every card on every state change) would
      // silently wipe out whatever the user just typed here.
      if (activeEl !== input && !(p.key in this._pending)) {
        input.value = value === null ? "" : fmt(value, p.digits);
      }
    }
  }

  _syncApplyBar(dirtyKeys) {
    const root = this.shadowRoot;
    const bar = root.querySelector(".apply-bar");
    const msg = bar.querySelector(".msg");
    const errEl = bar.querySelector(".error");
    const applyBtn = bar.querySelector(".btn-apply");
    const discardBtn = bar.querySelector(".btn-discard");

    if (!dirtyKeys.length) {
      bar.style.display = "none";
      return;
    }
    bar.style.display = "flex";

    const byKey = Object.fromEntries(PARAM_DEFS.map((p) => [p.key, p]));
    msg.innerHTML = dirtyKeys
      .map((k) => `${byKey[k].label}: <b>${fmt(this._live[k], byKey[k].digits)} → ${fmt(this._pending[k], byKey[k].digits)}</b>`)
      .join(" &middot; ");
    errEl.textContent = this._applyError || "";
    applyBtn.disabled = this._applying;
    applyBtn.textContent = this._applying ? "Applying…" : "Apply";
    discardBtn.disabled = this._applying;
  }

  // Draws a crosshair (vertical + horizontal dotted lines, a dot, and a
  // "T -> predicted flow temp" label) that follows the mouse across the
  // plotted curve, so hovering any outside temperature shows what the
  // curve would request there. Re-wired every render since the chart's
  // markup is rebuilt each time; the last pointer position is replayed
  // immediately so a periodic hass-driven re-render doesn't make the
  // crosshair disappear out from under a stationary mouse.
  _wireHover(chartSlot) {
    const svgEl = chartSlot.querySelector("svg");
    const capture = chartSlot.querySelector(".hover-capture");
    const group = chartSlot.querySelector(".hover-crosshair");
    const vline = chartSlot.querySelector(".hover-vline");
    const hline = chartSlot.querySelector(".hover-hline");
    const dot = chartSlot.querySelector(".hover-dot");
    const label = chartSlot.querySelector(".hover-label");
    if (!svgEl || !capture) return;

    const onMove = (clientX) => {
      const cs = this._chartState;
      const rect = svgEl.getBoundingClientRect();
      if (!cs || !rect.width) return;
      this._lastPointer = clientX;

      const scaleX = W / rect.width;
      let svgX = (clientX - rect.left) * scaleX;
      svgX = Math.max(cs.pad.l, Math.min(W - cs.pad.r, svgX));
      const T = X_MIN + ((svgX - cs.pad.l) / cs.plotW) * (X_MAX - X_MIN);
      const val = curveValue(T, cs.gradient, cs.lowEnd, cs.roomInf, cs.roomSet, cs.inside, true);
      const clampedVal = Math.max(cs.yLo, Math.min(cs.yHi, val));
      const y = cs.pad.t + (1 - (clampedVal - cs.yLo) / (cs.yHi - cs.yLo)) * cs.plotH;

      vline.setAttribute("x1", svgX.toFixed(1));
      vline.setAttribute("x2", svgX.toFixed(1));
      vline.setAttribute("y1", String(cs.pad.t));
      vline.setAttribute("y2", String(H - cs.pad.b));
      hline.setAttribute("x1", String(cs.pad.l));
      hline.setAttribute("x2", svgX.toFixed(1));
      hline.setAttribute("y1", y.toFixed(1));
      hline.setAttribute("y2", y.toFixed(1));
      dot.setAttribute("cx", svgX.toFixed(1));
      dot.setAttribute("cy", y.toFixed(1));

      const nearRight = svgX > W - cs.pad.r - 95;
      label.setAttribute("text-anchor", nearRight ? "end" : "start");
      label.setAttribute("x", (svgX + (nearRight ? -8 : 8)).toFixed(1));
      label.setAttribute("y", Math.max(cs.pad.t + 12, y - 8).toFixed(1));
      label.textContent = `${T.toFixed(1)}°C → ${val.toFixed(1)}°C`;

      group.style.display = "";
    };
    const onLeave = () => {
      this._lastPointer = null;
      group.style.display = "none";
    };

    capture.addEventListener("mousemove", (ev) => onMove(ev.clientX));
    capture.addEventListener("mouseleave", onLeave);
    capture.addEventListener("touchmove", (ev) => {
      if (ev.touches && ev.touches[0]) onMove(ev.touches[0].clientX);
    }, { passive: true });
    capture.addEventListener("touchend", onLeave);

    // Restore the crosshair through a re-render if the pointer never left.
    if (this._lastPointer !== null) onMove(this._lastPointer);
  }
}

customElements.define("thz-heating-curve-card", THZHeatingCurveCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "thz-heating-curve-card",
  name: "THZ Heating Curve Card",
  description: "Live HC1 weather-compensated heating curve for Stiebel Eltron / Tecalor THZ heat pumps, with a working-point marker and editable parameter fields.",
});
