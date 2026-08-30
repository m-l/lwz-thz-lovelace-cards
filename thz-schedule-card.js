// THZ Weekly Schedule Card
//
// Edits the comfort/day time windows for one program family (HC1 heating,
// HC2 heating, DHW hot water, or Fan ventilation) on a Stiebel Eltron /
// Tecalor LWZ/THZ heat pump managed by the `lwz-thz-403` integration.
//
// Important model note (see README): each slot below defines a COMFORT
// ("day") window. Any time NOT covered by a comfort window falls back to
// SETBACK automatically -- there is no separate "setback start/end" entity
// to edit. A slot may cross midnight by setting a start time later than its
// end time (e.g. 20:00 -> 02:00); this is native, documented Stiebel Eltron
// behaviour, not a workaround.
//
// Typing a time never writes to the device by itself -- it only stages a
// pending edit (dimmed/highlighted in the grid). Nothing is sent until
// "Apply"; "Discard" reverts all pending edits.

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

function fmtTimeState(stateObj) {
  // Returns "HH:MM" or "" (unset/unknown/unavailable).
  if (!stateObj) return "";
  const s = stateObj.state;
  if (!s || s === "unknown" || s === "unavailable" || s === "none") return "";
  // HA time entity states are already "HH:MM:SS" or "HH:MM"; keep HH:MM.
  return s.slice(0, 5);
}

class ThzScheduleCard extends HTMLElement {
  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");

    const family = String(config.family || "hc1").toLowerCase();
    const slots = Number.isInteger(config.slots) ? config.slots : 3;
    const prefix = config.entity_id_prefix != null ? config.entity_id_prefix : "lwz403";
    const template =
      config.entity_template || "time.{prefix}_program_{family}_{day}_{slot}_{part}";
    const days = config.days || DAY_DEFS;
    const fontSize = config.font_size || 14;
    const title = config.title || FAMILY_TITLES[family] || "THZ Schedule";

    this._config = { ...config, family, slots, prefix, template, days, fontSize, title };
    this._pending = {}; // entity_id -> "HH:MM" (staged, not yet applied)
    this._applying = false;
    this._applyError = "";

    // entity_id -> { day, slot, part }
    this._entityMeta = {};
    for (const d of days) {
      for (let s = 0; s < slots; s++) {
        for (const part of ["start", "end"]) {
          const id = this._entityIdFor(d.key, s, part);
          this._entityMeta[id] = { day: d.key, slot: s, part };
        }
      }
    }

    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    this._buildStaticDom();
    if (this._hass) this._syncAll();
  }

  _entityIdFor(day, slot, part) {
    return this._config.template
      .replaceAll("{prefix}", this._config.prefix)
      .replaceAll("{family}", this._config.family)
      .replaceAll("{day}", day)
      .replaceAll("{slot}", String(slot))
      .replaceAll("{part}", part);
  }

  set hass(hass) {
    this._hass = hass;
    this._syncAll();
  }

  getCardSize() {
    return 2 + this._config.days.length;
  }

  // ---- static DOM (built once per setConfig call) ----

  _buildStaticDom() {
    const { days, slots, fontSize, title } = this._config;

    let headRow2 = "";
    let headRow1 = `<th class="daycol"></th>`;
    for (let s = 0; s < slots; s++) {
      headRow1 += `<th class="slothead" colspan="2">Slot ${s + 1}</th>`;
      headRow2 += `<th class="subhead">Start</th><th class="subhead">End</th>`;
    }

    let bodyRows = "";
    for (const d of days) {
      let cells = `<td class="daycol">${d.label}</td>`;
      for (let s = 0; s < slots; s++) {
        for (const part of ["start", "end"]) {
          const id = this._entityIdFor(d.key, s, part);
          cells += `
            <td class="timecell" data-entity="${id}">
              <input type="time" data-entity="${id}" aria-label="${d.label} slot ${s + 1} ${part}" />
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
        .head h1 { font-size: 1.25em; font-weight: 600; margin: 0 0 2px; color: var(--primary-text-color); }
        .hint {
          font-size: 0.85em; color: var(--secondary-text-color); margin-bottom: 10px;
          line-height: 1.4;
        }
        .missing-banner {
          background: color-mix(in srgb, var(--warning-color, #ff9800) 15%, transparent);
          border: 1px solid var(--warning-color, #ff9800);
          color: var(--primary-text-color);
          border-radius: 6px; padding: 8px 10px; font-size: 0.85em; margin-bottom: 10px;
          line-height: 1.4;
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
        input[type="time"] {
          width: 5.5em; padding: 3px 4px; border-radius: 4px;
          border: 1px solid var(--divider-color); background: var(--card-background-color);
          color: var(--primary-text-color); font-family: inherit; font-size: 0.95em;
          font-variant-numeric: tabular-nums;
        }
        input[type="time"]:focus { outline: 2px solid var(--primary-color, #03a9f4); outline-offset: -1px; }
        input[type="time"].dirty { border-color: var(--primary-color, #03a9f4); border-width: 2px; }
        input[type="time"]:disabled {
          opacity: 0.45; background: var(--divider-color); cursor: not-allowed;
        }
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
        <div class="head"><h1>${title}</h1></div>
        <div class="hint">
          Each slot is a <b>comfort</b> window; time outside every slot falls back to
          <b>setback</b> automatically. Set a start time later than its end time
          (e.g. 20:00&nbsp;&rarr;&nbsp;02:00) to span midnight -- supported natively by the
          device. Typing a time only stages the change; click Apply to send it.
        </div>
        <div class="missing-banner" style="display:none;"></div>
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

    this._inputs = {};
    this._liveNotes = {};
    for (const id of Object.keys(this._entityMeta)) {
      this._inputs[id] = this.shadowRoot.querySelector(`input[data-entity="${id}"]`);
      this._liveNotes[id] = this.shadowRoot.querySelector(`[data-entity-note="${id}"]`);
      this._inputs[id].addEventListener("input", (ev) => this._onFieldInput(id, ev));
    }
    this._missingBanner = this.shadowRoot.querySelector(".missing-banner");
    this._applyBar = this.shadowRoot.querySelector(".apply-bar");
    this._applyMsg = this.shadowRoot.querySelector(".apply-bar .msg");
    this._applyErrorEl = this.shadowRoot.querySelector(".apply-bar .error");
    this._applyBtn = this.shadowRoot.querySelector(".btn-apply");
    this.shadowRoot.querySelector(".btn-discard").addEventListener("click", () => this._onDiscard());
    this._applyBtn.addEventListener("click", () => this._onApply());

    this._liveValues = {}; // entity_id -> "HH:MM" | "" as last known from hass
  }

  // ---- hass -> DOM sync ----

  _syncAll() {
    if (!this._hass || !this.shadowRoot) return;

    let missing = 0;
    const total = Object.keys(this._entityMeta).length;

    for (const id of Object.keys(this._entityMeta)) {
      const stateObj = this._hass.states[id];
      const input = this._inputs[id];
      if (!stateObj) {
        missing++;
        input.disabled = true;
        input.title = `${id} was not found. It may be disabled -- set "Entity visibility" ` +
          `to Extended or All in the integration's options, then enable it under ` +
          `Settings → Devices & services → Entities.`;
        this._liveValues[id] = "";
        if (!(id in this._pending)) input.value = "";
        continue;
      }
      input.disabled = false;
      input.title = "";
      const live = fmtTimeState(stateObj);
      this._liveValues[id] = live;
      if (!(id in this._pending)) {
        input.value = live;
        input.classList.remove("dirty");
        this._liveNotes[id].textContent = "";
      } else {
        input.classList.add("dirty");
        this._liveNotes[id].textContent = live ? `was ${live}` : "was unset";
      }
    }

    if (missing > 0) {
      this._missingBanner.style.display = "block";
      this._missingBanner.textContent =
        `${missing} of ${total} schedule entities for "${this._config.family}" were not found. ` +
        `They're likely disabled by default -- set "Entity visibility" to Extended or All in the ` +
        `lwz-thz-403 integration's options, then enable the remaining ones under ` +
        `Settings → Devices & services → Entities (search "program_${this._config.family}").`;
    } else {
      this._missingBanner.style.display = "none";
    }

    this._syncApplyBar();
  }

  // ---- editing ----

  _onFieldInput(id, ev) {
    const value = ev.target.value; // "" or "HH:MM"
    if (value === this._liveValues[id]) {
      delete this._pending[id];
      ev.target.classList.remove("dirty");
      this._liveNotes[id].textContent = "";
    } else {
      this._pending[id] = value;
      ev.target.classList.add("dirty");
      this._liveNotes[id].textContent = this._liveValues[id] ? `was ${this._liveValues[id]}` : "was unset";
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
    }
    this._pending = {};
    this._applyError = "";
    this._syncApplyBar();
  }

  async _onApply() {
    const entries = Object.entries(this._pending);
    if (entries.length === 0) return;

    const blank = entries.filter(([, v]) => v === "");
    if (blank.length > 0) {
      this._applyError =
        "Can't clear a slot to “unset” from this card (the time.set_value service " +
        "requires a real time) -- type a time instead, or clear it from the device's own menu.";
      this._syncApplyBar();
      return;
    }

    this._applying = true;
    this._applyError = "";
    this._syncApplyBar();

    try {
      await Promise.all(
        entries.map(([id, value]) =>
          this._hass.callService("time", "set_value", { entity_id: id, time: value })
        )
      );
      this._pending = {};
    } catch (err) {
      this._applyError = (err && err.message) || String(err);
    } finally {
      this._applying = false;
      this._syncApplyBar();
    }
  }
}

customElements.define("thz-schedule-card", ThzScheduleCard);

// Register with the Lovelace card picker.
window.customCards = window.customCards || [];
window.customCards.push({
  type: "thz-schedule-card",
  name: "THZ Weekly Schedule",
  description: "Edit weekly comfort-window schedules (HC1/HC2/DHW/Fan) for a Stiebel Eltron / Tecalor LWZ/THZ heat pump.",
});
