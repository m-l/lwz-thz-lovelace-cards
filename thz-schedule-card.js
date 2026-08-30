// THZ Weekly Schedule Card
//
// Edits the comfort/day time windows for one program family (HC1 heating,
// HC2 heating, DHW hot water, or Fan ventilation) on a Stiebel Eltron /
// Tecalor LWZ/THZ heat pump managed by the `lwz-thz-403` integration --
// plus the Day/Night/Standby setpoint that each window switches between.
// A dropdown at the top of the card switches between families without
// touching the dashboard YAML.
//
// Important model note (see README): each slot below defines a COMFORT
// ("day") window. Any time NOT covered by a comfort window falls back to
// SETBACK ("night") automatically -- there is no separate "setback
// start/end" entity to edit. A slot may cross midnight by setting a start
// time later than its end time (e.g. 20:00 -> 02:00); this is native,
// documented Stiebel Eltron behaviour, not a workaround.
//
// Typing a time or a setpoint never writes to the device by itself -- it
// only stages a pending edit (dimmed/highlighted). Nothing is sent until
// "Apply"; "Discard" reverts all pending edits, whether they're times or
// setpoints.
//
// Each time field also has a small "x" button to clear its whole slot
// (both Start and End) back to the device's own "unset" state (equivalent
// to clearing that slot from the heat pump's own menu) -- a slot only
// makes sense as a Start+End pair, so clearing one half also clears the
// other. This goes through a dedicated `thz.clear_value` service rather
// than `time.set_value`, since Home Assistant's built-in service has no
// way to represent "no time" -- see README.

const DAY_DEFS = [
  { key: "mo", label: "Mon" },
  { key: "tu", label: "Tue" },
  { key: "we", label: "Wed" },
  { key: "th", label: "Thu" },
  { key: "fr", label: "Fri" },
  { key: "sa", label: "Sat" },
  { key: "so", label: "Sun" },
];

const FAMILY_TITLES = {
  hc1: "HC1 Heating Schedule",
  hc2: "HC2 Heating Schedule",
  dhw: "DHW Schedule",
  fan: "Ventilation Schedule",
};

// Families offered by the in-card switcher. HC2 is intentionally left out
// of this list (per the integration's own default scope) but still works
// if you set `family: hc2` in YAML -- it just won't appear in the dropdown.
const SWITCHABLE_FAMILIES = ["hc1", "dhw", "fan"];

// The setpoint each family's comfort/setback windows switch between.
// `base` is the integration's internal register name -- run through the
// same slugging rule as the entity_id_style="fhem" naming (see slugify()
// below) to get the default entity_id, exactly like the time entities.
const FAMILY_SETPOINTS = {
  hc1: [
    { key: "day", label: "Day (comfort)", base: "p01RoomTempDayHC1" },
    { key: "night", label: "Night (setback)", base: "p02RoomTempNightHC1" },
    { key: "standby", label: "Standby", base: "p03RoomTempStandbyHC1" },
  ],
  hc2: [
    { key: "day", label: "Day (comfort)", base: "p01RoomTempDayHC2" },
    { key: "night", label: "Night (setback)", base: "p02RoomTempNightHC2" },
    { key: "standby", label: "Standby", base: "p03RoomTempStandbyHC2" },
  ],
  dhw: [
    { key: "day", label: "Day (comfort)", base: "p04DHWsetDayTemp" },
    { key: "night", label: "Night (setback)", base: "p05DHWsetNightTemp" },
    { key: "standby", label: "Standby", base: "p06DHWsetStandbyTemp" },
  ],
  fan: [
    { key: "day", label: "Day (comfort)", base: "p07FanStageDay" },
    { key: "night", label: "Night (setback)", base: "p08FanStageNight" },
    { key: "standby", label: "Standby", base: "p09FanStageStandby" },
  ],
};

function slugify(name) {
  // Mirrors the integration's fhem_style_object_id() slug algorithm
  // (entity_id_style.py): split only at a lowercase/digit-to-uppercase
  // boundary, replace anything else non-alphanumeric with "_", lowercase,
  // collapse repeated underscores.
  let s = String(name).trim();
  s = s.replace(/([a-z0-9])(?=[A-Z])/g, "$1_");
  s = s.replace(/[^0-9a-zA-Z]+/g, "_");
  s = s.toLowerCase();
  s = s.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return s || "thz_entity";
}

function fmtTimeState(stateObj) {
  // Returns "HH:MM" or "" (unset/unknown/unavailable).
  if (!stateObj) return "";
  const s = stateObj.state;
  if (!s || s === "unknown" || s === "unavailable" || s === "none") return "";
  return s.slice(0, 5);
}

function decimalsOf(step) {
  const s = String(step ?? "1");
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

function describeError(err) {
  // hass.callService() doesn't always reject with a plain Error -- a
  // failed websocket call can reject with a {code, message} result object,
  // or one nested under .error. Try the shapes actually seen in practice
  // before falling back to a raw dump, so the apply-bar never just shows
  // an unhelpful "[object Object]".
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  if (err.error) return describeError(err.error);
  if (err.code) return `${err.code}${err.message ? ": " + err.message : ""}`;
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") return json;
  } catch (_e) {
    // fall through
  }
  return String(err);
}

class ThzScheduleCard extends HTMLElement {
  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");

    this._rawConfig = config;
    this._slots = Number.isInteger(config.slots) ? config.slots : 3;
    this._prefix = config.entity_id_prefix != null ? config.entity_id_prefix : "lwz403";
    this._template =
      config.entity_template || "time.{prefix}_program_{family}_{day}_{slot}_{part}";
    this._days = config.days || DAY_DEFS;
    this._fontSize = config.font_size || 14;
    this._userTitle = config.title || null;

    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }

    this._pending = {}; // entity_id -> { kind: "time"|"number", value }
    this._applying = false;
    this._applyError = "";
    this._currentFamily = String(config.family || "hc1").toLowerCase();
    this._initFamily(this._currentFamily);
  }

  // (Re)computes every family-dependent entity mapping and rebuilds the DOM
  // for that family. Called on initial setConfig and whenever the in-card
  // dropdown switches families.
  _initFamily(family) {
    this._currentFamily = family;
    this._title = this._userTitle || FAMILY_TITLES[family] || "THZ Schedule";

    // ---- time fields: entity_id -> { day, slot, part } ----
    this._timeMeta = {};
    for (const d of this._days) {
      for (let s = 0; s < this._slots; s++) {
        for (const part of ["start", "end"]) {
          const id = this._entityIdFor(family, d.key, s, part);
          this._timeMeta[id] = { day: d.key, slot: s, part };
        }
      }
    }

    // ---- setpoint fields ----
    // Config-level `entities` overrides only apply to the family named in
    // YAML; switching to a different family via the dropdown falls back to
    // the default naming for that family.
    const isConfiguredFamily = family === String(this._rawConfig.family || "hc1").toLowerCase();
    const setpointOverrides = isConfiguredFamily ? this._rawConfig.entities || {} : {};
    const setpointDefs = FAMILY_SETPOINTS[family] || [];
    this._setpoints = setpointDefs.map((def) => ({
      ...def,
      entityId:
        setpointOverrides[def.key] ||
        `number.${this._prefix ? this._prefix + "_" : ""}${slugify(def.base)}`,
    }));

    this._pending = {};
    this._applying = false;
    this._applyError = "";
    this._liveValues = {};
    this._numMeta = {};

    this._buildStaticDom();
    if (this._hass) this._syncAll();
  }

  _entityIdFor(family, day, slot, part) {
    return this._template
      .replaceAll("{prefix}", this._prefix)
      .replaceAll("{family}", family)
      .replaceAll("{day}", day)
      .replaceAll("{slot}", String(slot))
      .replaceAll("{part}", part);
  }

  set hass(hass) {
    this._hass = hass;
    this._syncAll();
  }

  getCardSize() {
    return 3 + this._days.length;
  }

  // ---- static DOM (rebuilt whenever the family changes) ----

  _buildStaticDom() {
    const { _slots: slots, _days: days, _fontSize: fontSize, _title: title } = this;

    let familyOptions = "";
    for (const fam of SWITCHABLE_FAMILIES) {
      familyOptions += `<option value="${fam}"${fam === this._currentFamily ? " selected" : ""}>${FAMILY_TITLES[fam]}</option>`;
    }
    // If configured with a family outside the switcher's list (e.g. hc2),
    // keep it selectable so the dropdown always reflects reality.
    if (!SWITCHABLE_FAMILIES.includes(this._currentFamily)) {
      familyOptions += `<option value="${this._currentFamily}" selected>${FAMILY_TITLES[this._currentFamily] || this._currentFamily}</option>`;
    }

    let setpointCells = "";
    for (const sp of this._setpoints) {
      setpointCells += `
        <div class="setpoint" data-entity="${sp.entityId}">
          <label>${sp.label}</label>
          <div class="setpoint-input-row">
            <input type="number" inputmode="decimal" data-entity="${sp.entityId}" data-kind="number"
                   aria-label="${sp.label}" />
            <span class="unit" data-unit="${sp.entityId}"></span>
          </div>
          <div class="live-note" data-entity-note="${sp.entityId}"></div>
        </div>`;
    }

    // headRow1 groups two columns per slot under "Slot N"; headRow2 labels
    // each of those two columns "Start"/"End". Both rows need the SAME
    // leading blank cell for the day-name column, or the Start/End labels
    // in row 2 end up shifted one column left of the data they describe.
    let headRow1 = `<th class="daycol"></th>`;
    let headRow2 = `<th class="daycol"></th>`;
    for (let s = 0; s < slots; s++) {
      headRow1 += `<th class="slothead" colspan="2">Slot ${s + 1}</th>`;
      headRow2 += `<th class="subhead">Start</th><th class="subhead">End</th>`;
    }

    let bodyRows = "";
    for (const d of days) {
      let cells = `<td class="daycol">${d.label}</td>`;
      for (let s = 0; s < slots; s++) {
        for (const part of ["start", "end"]) {
          const id = this._entityIdFor(this._currentFamily, d.key, s, part);
          cells += `
            <td class="timecell" data-entity="${id}">
              <div class="time-input-row">
                <input type="time" data-entity="${id}" data-kind="time"
                       aria-label="${d.label} slot ${s + 1} ${part}" />
                <button type="button" class="clear-btn" data-entity="${id}"
                        title="Clear to unset" aria-label="Clear ${d.label} slot ${s + 1} ${part}">✕</button>
              </div>
              <div class="live-note" data-entity-note="${id}"></div>
            </td>`;
        }
      }
      bodyRows += `<tr data-day="${d.key}">${cells}</tr>`;
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host { --sc-font-size: ${fontSize}px; }
        ha-card { padding: 16px 16px 10px; font-size: var(--sc-font-size); }
        .head {
          display: flex; align-items: center; justify-content: space-between;
          gap: 12px; flex-wrap: wrap; margin-bottom: 2px;
        }
        .head h1 { font-size: 1.25em; font-weight: 600; margin: 0; color: var(--primary-text-color); }
        .family-select {
          padding: 4px 8px; border-radius: 6px; font-size: 0.85em;
          border: 1px solid var(--divider-color); background: var(--card-background-color);
          color: var(--primary-text-color); font-family: inherit;
        }
        .hint {
          font-size: 0.85em; color: var(--secondary-text-color); margin: 6px 0 10px;
          line-height: 1.4;
        }
        .missing-banner {
          background: color-mix(in srgb, var(--warning-color, #ff9800) 15%, transparent);
          border: 1px solid var(--warning-color, #ff9800);
          color: var(--primary-text-color);
          border-radius: 6px; padding: 8px 10px; font-size: 0.85em; margin-bottom: 10px;
          line-height: 1.4;
        }
        .setpoints {
          display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 14px;
          padding-bottom: 12px; border-bottom: 1px solid var(--divider-color);
        }
        .setpoint label {
          display: block; font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.03em;
          color: var(--secondary-text-color); margin-bottom: 3px;
        }
        .setpoint-input-row { display: flex; align-items: baseline; gap: 5px; }
        .setpoint .unit { font-size: 0.85em; color: var(--secondary-text-color); }
        .setpoint input[type="number"] {
          width: 4.5em; padding: 4px 6px; border-radius: 4px;
          border: 1px solid var(--divider-color); background: var(--card-background-color);
          color: var(--primary-text-color); font-family: inherit; font-size: 1em;
          font-variant-numeric: tabular-nums;
        }
        .grid-wrap { overflow-x: auto; }
        table.sched { border-collapse: collapse; width: 100%; min-width: 560px; }
        table.sched th, table.sched td { padding: 4px 6px; text-align: center; }
        th.daycol { text-align: left; }
        td.daycol {
          text-align: left; font-weight: 600; color: var(--primary-text-color);
          white-space: nowrap;
        }
        th.slothead {
          border-bottom: 1px solid var(--divider-color); color: var(--primary-text-color);
          font-size: 0.9em; border-left: 2px solid var(--divider-color);
        }
        th.subhead {
          color: var(--secondary-text-color); font-weight: 400; font-size: 0.75em;
          text-transform: uppercase; letter-spacing: 0.03em;
          border-bottom: 1px solid var(--divider-color);
        }
        table.sched th.slothead:first-of-type,
        table.sched td.timecell:nth-child(2) { border-left: none; }
        td.timecell[data-entity]:nth-of-type(odd) { border-left: 2px solid var(--divider-color); }
        tr[data-day] td.timecell:first-of-type { border-left: 2px solid var(--divider-color); }
        input[type="time"], input[type="number"] {
          font-variant-numeric: tabular-nums;
        }
        input[type="time"] {
          width: 5.5em; padding: 3px 4px; border-radius: 4px;
          border: 1px solid var(--divider-color); background: var(--card-background-color);
          color: var(--primary-text-color); font-family: inherit; font-size: 0.95em;
        }
        input[type="time"]:focus, input[type="number"]:focus {
          outline: 2px solid var(--primary-color, #03a9f4); outline-offset: -1px;
        }
        input.dirty { border-color: var(--primary-color, #03a9f4); border-width: 2px; }
        input:disabled {
          opacity: 0.45; background: var(--divider-color); cursor: not-allowed;
        }
        .time-input-row { display: flex; align-items: center; justify-content: center; gap: 3px; }
        .clear-btn {
          padding: 1px 5px; font-size: 0.75em; line-height: 1.4; border-radius: 4px;
          border: 1px solid var(--divider-color); background: transparent;
          color: var(--secondary-text-color); cursor: pointer; font-family: inherit;
        }
        .clear-btn:hover:not(:disabled) {
          color: var(--error-color, #db4437); border-color: var(--error-color, #db4437);
        }
        .clear-btn:disabled { opacity: 0.3; cursor: not-allowed; }
        .clear-btn.dirty { border-color: var(--primary-color, #03a9f4); border-width: 2px; }
        .live-note {
          font-size: 0.7em; color: var(--secondary-text-color); min-height: 1.1em;
          font-variant-numeric: tabular-nums;
        }
        .apply-bar {
          display: none; align-items: center; gap: 10px; flex-wrap: wrap;
          margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--divider-color);
        }
        .apply-bar .msg { flex: 1; min-width: 180px; font-size: 0.9em; color: var(--secondary-text-color); }
        .apply-bar .msg b { color: var(--primary-text-color); }
        .apply-bar .error { color: var(--error-color, #db4437); font-size: 0.85em; flex-basis: 100%; }
        .apply-bar button {
          padding: 6px 14px; border-radius: 6px; font-size: 0.9em; cursor: pointer;
          border: 1px solid var(--divider-color);
        }
        .btn-discard { background: transparent; border-color: var(--divider-color); color: var(--primary-text-color); }
        .btn-apply {
          background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff);
          border-color: transparent; font-weight: 600;
        }
        .btn-apply:disabled { opacity: 0.6; cursor: not-allowed; }
      </style>
      <ha-card>
        <div class="head">
          <h1>${title}</h1>
          <select class="family-select" aria-label="Program family">${familyOptions}</select>
        </div>
        <div class="hint">
          Each slot is a <b>comfort</b> window; time outside every slot falls back to
          <b>setback</b> automatically, using the Night setpoint below. Set a start time
          later than its end time (e.g. 20:00&nbsp;&rarr;&nbsp;02:00) to span midnight --
          supported natively by the device. Typing a value only stages the change; click
          Apply to send it. Use the <b>✕</b> next to a time field to clear that whole
          slot (both Start and End) back to "unset" instead of typing a time.
        </div>
        <div class="missing-banner" style="display:none;"></div>
        <div class="setpoints">${setpointCells}</div>
        <div class="grid-wrap">
          <table class="sched">
            <thead>
              <tr>${headRow1}</tr>
              <tr>${headRow2}</tr>
            </thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>
        <div class="apply-bar">
          <span class="msg"></span>
          <span class="error"></span>
          <button class="btn-discard">Discard</button>
          <button class="btn-apply">Apply</button>
        </div>
      </ha-card>
    `;

    // Build a unified field registry covering both time cells and setpoints.
    this._fields = {};
    for (const id of Object.keys(this._timeMeta)) {
      this._fields[id] = { kind: "time" };
    }
    for (const sp of this._setpoints) {
      this._fields[sp.entityId] = { kind: "number" };
    }

    this._inputs = {};
    this._liveNotes = {};
    this._unitEls = {};
    this._clearBtns = {};
    for (const id of Object.keys(this._fields)) {
      this._inputs[id] = this.shadowRoot.querySelector(`input[data-entity="${id}"]`);
      this._liveNotes[id] = this.shadowRoot.querySelector(`[data-entity-note="${id}"]`);
      this._inputs[id].addEventListener("input", (ev) => this._onFieldInput(id, ev));
    }
    for (const id of Object.keys(this._timeMeta)) {
      const btn = this.shadowRoot.querySelector(`.clear-btn[data-entity="${id}"]`);
      this._clearBtns[id] = btn;
      btn.addEventListener("click", () => this._onClearClick(id));
    }
    for (const sp of this._setpoints) {
      this._unitEls[sp.entityId] = this.shadowRoot.querySelector(`[data-unit="${sp.entityId}"]`);
    }

    this._missingBanner = this.shadowRoot.querySelector(".missing-banner");
    this._applyBar = this.shadowRoot.querySelector(".apply-bar");
    this._applyMsg = this.shadowRoot.querySelector(".apply-bar .msg");
    this._applyErrorEl = this.shadowRoot.querySelector(".apply-bar .error");
    this._applyBtn = this.shadowRoot.querySelector(".btn-apply");
    this.shadowRoot.querySelector(".btn-discard").addEventListener("click", () => this._onDiscard());
    this._applyBtn.addEventListener("click", () => this._onApply());
    this._familySelect = this.shadowRoot.querySelector(".family-select");
    this._familySelect.addEventListener("change", (ev) => this._onFamilyChange(ev.target.value));
  }

  // ---- family switching ----

  _onFamilyChange(newFamily) {
    if (Object.keys(this._pending).length > 0) {
      // Don't silently discard in-progress edits -- send the dropdown back
      // to the family that's actually showing, and explain why.
      this._familySelect.value = this._currentFamily;
      this._applyError = "Apply or Discard your pending changes before switching schedules.";
      this._syncApplyBar();
      return;
    }
    this._initFamily(newFamily);
  }

  // ---- hass -> DOM sync ----

  _syncAll() {
    if (!this._hass || !this.shadowRoot) return;

    let missing = 0;
    const total = Object.keys(this._fields).length;

    for (const [id, meta] of Object.entries(this._fields)) {
      const stateObj = this._hass.states[id];
      const input = this._inputs[id];
      const pending = this._pending[id];

      if (!stateObj) {
        missing++;
        input.disabled = true;
        input.title = `${id} was not found. It may be disabled -- set "Entity visibility" ` +
          `to Extended or All in the integration's options, then enable it under ` +
          `Settings → Devices & services → Entities.`;
        this._liveValues[id] = "";
        if (!pending) input.value = "";
        if (this._clearBtns[id]) this._clearBtns[id].disabled = true;
        continue;
      }
      input.disabled = false;
      input.title = "";
      if (this._clearBtns[id]) this._clearBtns[id].disabled = false;

      let live;
      if (meta.kind === "time") {
        live = fmtTimeState(stateObj);
      } else {
        const min = stateObj.attributes.min;
        const max = stateObj.attributes.max;
        const step = stateObj.attributes.step ?? 1;
        const unit = (stateObj.attributes.unit_of_measurement || "").trim();
        this._numMeta[id] = { min, max, step, unit };
        if (this._unitEls[id]) this._unitEls[id].textContent = unit;
        input.step = step;
        if (min != null) input.min = min;
        if (max != null) input.max = max;
        const num = Number(stateObj.state);
        live = Number.isFinite(num) ? num.toFixed(decimalsOf(step)) : "";
      }

      this._liveValues[id] = live;
      if (!pending) {
        input.value = live;
        input.classList.remove("dirty");
        this._liveNotes[id].textContent = "";
        if (this._clearBtns[id]) this._clearBtns[id].classList.remove("dirty");
      } else {
        input.classList.add("dirty");
        this._liveNotes[id].textContent = live ? `was ${live}` : "was unset";
        if (this._clearBtns[id]) {
          this._clearBtns[id].classList.toggle("dirty", pending.kind === "time-clear");
        }
      }
    }

    if (missing > 0) {
      this._missingBanner.style.display = "block";
      this._missingBanner.textContent =
        `${missing} of ${total} entities for "${this._currentFamily}" were not found. ` +
        `They're likely disabled by default -- set "Entity visibility" to Extended or All in the ` +
        `lwz-thz-403 integration's options, then enable the remaining ones under ` +
        `Settings → Devices & services → Entities (search "program_${this._currentFamily}" or the ` +
        `family's setpoint names).`;
    } else {
      this._missingBanner.style.display = "none";
    }

    this._syncApplyBar();
  }

  // ---- editing ----

  _onFieldInput(id, ev) {
    const kind = this._fields[id].kind;
    const value = ev.target.value; // "" or "HH:MM" (time) / numeric string (number)
    if (value === this._liveValues[id]) {
      delete this._pending[id];
      ev.target.classList.remove("dirty");
      this._liveNotes[id].textContent = "";
    } else {
      // Typing (even blank) always stages a normal "time"/"number" edit;
      // it overrides any previously-staged Clear action for this field.
      this._pending[id] = { kind, value };
      ev.target.classList.add("dirty");
      this._liveNotes[id].textContent = this._liveValues[id] ? `was ${this._liveValues[id]}` : "was unset";
    }
    if (this._clearBtns[id]) {
      this._clearBtns[id].classList.toggle("dirty", this._pending[id]?.kind === "time-clear");
    }
    this._syncApplyBar();
  }

  // Stages an explicit "clear this field to the device's unset state"
  // edit, distinct from a normal typed value -- see _onApply for how the
  // two are sent differently (thz.clear_value vs time.set_value).
  //
  // A slot only makes sense as a Start+End pair -- an "unset" start with a
  // real end (or vice versa) doesn't describe anything meaningful -- so
  // clicking Clear on either half stages clearing BOTH halves of that same
  // slot together. If the other half's entity happens to be missing (not
  // found in hass.states), only the clicked field is staged.
  _onClearClick(id) {
    if (this._inputs[id].disabled) return;

    const meta = this._timeMeta[id];
    const otherPart = meta.part === "start" ? "end" : "start";
    const pairId = this._entityIdFor(this._currentFamily, meta.day, meta.slot, otherPart);

    const ids = [id];
    if (this._inputs[pairId] && !this._inputs[pairId].disabled) {
      ids.push(pairId);
    }

    for (const fid of ids) {
      this._pending[fid] = { kind: "time-clear", value: "" };
      this._inputs[fid].value = "";
      this._inputs[fid].classList.add("dirty");
      if (this._clearBtns[fid]) this._clearBtns[fid].classList.add("dirty");
      this._liveNotes[fid].textContent = this._liveValues[fid] ? `was ${this._liveValues[fid]}` : "was unset";
    }
    this._syncApplyBar();
  }

  _syncApplyBar() {
    const keys = Object.keys(this._pending);
    if (keys.length === 0 && !this._applying) {
      this._applyBar.style.display = "none";
      this._applyErrorEl.textContent = "";
      return;
    }
    this._applyBar.style.display = "flex";
    this._applyMsg.innerHTML = this._applying
      ? "Applying&hellip;"
      : `<b>${keys.length}</b> field${keys.length === 1 ? "" : "s"} changed, not yet sent to the device.`;
    this._applyBtn.disabled = this._applying || keys.length === 0;
    this._applyErrorEl.textContent = this._applyError || "";
  }

  _onDiscard() {
    for (const id of Object.keys(this._pending)) {
      this._inputs[id].value = this._liveValues[id] || "";
      this._inputs[id].classList.remove("dirty");
      this._liveNotes[id].textContent = "";
      if (this._clearBtns[id]) this._clearBtns[id].classList.remove("dirty");
    }
    this._pending = {};
    this._applyError = "";
    this._syncApplyBar();
  }

  async _onApply() {
    const entries = Object.entries(this._pending);
    if (entries.length === 0) return;

    const blankTimes = entries.filter(([, v]) => v.kind === "time" && v.value === "");
    if (blankTimes.length > 0) {
      this._applyError =
        "A time field was left blank. Use the “✕” Clear button next to it to unset " +
        "that slot, or type a real time.";
      this._syncApplyBar();
      return;
    }
    const blankNums = entries.filter(([, v]) => v.kind === "number" && v.value === "");
    if (blankNums.length > 0) {
      this._applyError = "Enter a value for every changed setpoint before applying.";
      this._syncApplyBar();
      return;
    }

    this._applying = true;
    this._applyError = "";
    this._syncApplyBar();

    // Sent one at a time, deliberately -- a schedule slot's Start and End
    // are two separate time.* entities that share one physical 4-byte
    // register on the device, and the integration's read-modify-write for
    // each one briefly releases its device lock between the read and the
    // write. Firing them concurrently (e.g. via Promise.all) lets two
    // writes to the same slot race on the wire, which surfaces as a
    // generic "unknown error" from the service call. Applying sequentially
    // keeps at most one device write in flight at any moment.
    let failure = null;
    for (const [id, { kind, value }] of entries) {
      try {
        let appliedValue = value;
        if (kind === "time") {
          await this._hass.callService("time", "set_value", { entity_id: id, time: value });
        } else if (kind === "time-clear") {
          // Home Assistant's time.set_value service can't represent "no
          // time" -- its schema requires a real value -- so clearing a
          // slot goes through the integration's own thz.clear_value
          // entity service instead, which writes the device's "unset"
          // sentinel directly.
          await this._hass.callService("thz", "clear_value", { entity_id: id });
          appliedValue = "";
        } else {
          const meta = this._numMeta[id] || {};
          let num = Number(value);
          if (meta.min != null) num = Math.max(Number(meta.min), num);
          if (meta.max != null) num = Math.min(Number(meta.max), num);
          await this._hass.callService("number", "set_value", { entity_id: id, value: num });
          appliedValue = num.toFixed(decimalsOf(meta.step));
        }
        // Optimistically reflect the write immediately rather than waiting
        // for the next poll to confirm it -- clear the pending edit and its
        // dirty styling, and show the (possibly clamped) applied value.
        delete this._pending[id];
        this._liveValues[id] = appliedValue;
        this._inputs[id].value = appliedValue;
        this._inputs[id].classList.remove("dirty");
        if (this._clearBtns[id]) this._clearBtns[id].classList.remove("dirty");
        this._liveNotes[id].textContent = "";
      } catch (err) {
        failure = `${id}: ${describeError(err)}`;
        break; // Stop here; this field and any not-yet-attempted ones stay pending.
      }
    }

    this._applying = false;
    this._applyError = failure || "";
    this._syncApplyBar();
  }
}

customElements.define("thz-schedule-card", ThzScheduleCard);

// Register with the Lovelace card picker.
window.customCards = window.customCards || [];
window.customCards.push({
  type: "thz-schedule-card",
  name: "THZ Weekly Schedule",
  description: "Edit weekly comfort-window schedules and their Day/Night/Standby setpoints (HC1/HC2/DHW/Fan) for a Stiebel Eltron / Tecalor LWZ/THZ heat pump.",
});
