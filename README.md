# THZ Lovelace Cards

Two Home Assistant Lovelace cards for a Stiebel Eltron / Tecalor LWZ/THZ
heat pump managed by the
[`lwz-thz-403`](https://github.com/m-l/lwz-thz-403) integration:

- **Heating Curve Card** (`custom:thz-heating-curve-card`) — plots the live
  heating curve and lets you tune Gradient, Low End and Room Influence with
  immediate visual feedback.
- **Weekly Schedule Card** (`custom:thz-schedule-card`) — a 7-day grid for
  editing the HC1/HC2/DHW/Fan comfort-window schedules.

<img width="496" height="463" alt="image" src="https://github.com/user-attachments/assets/157f46fc-793f-470e-a749-5141c55cfe8b" />

## Installation

### HACS (recommended)

1. In Home Assistant, go to **HACS → ⋮ (top right) → Custom repositories**.
2. Add `https://github.com/m-l/lwz-thz-lovelace-cards`, category **Dashboard**.
3. Find **THZ Lovelace Cards** in HACS and install it.
4. HACS registers `thz-heating-curve-card.js` as a Lovelace resource for you. If it doesn't show up in the card picker, add it manually under **Settings → Dashboards → Resources**: URL `/hacsfiles/lwz-thz-lovelace-cards/thz-heating-curve-card.js`, type **JavaScript Module** — then hard-refresh your browser.
5. HACS downloads the whole repository, so `thz-schedule-card.js` lands alongside it automatically — it just isn't auto-registered, since a HACS "Dashboard" repo only auto-registers the one `filename` listed in `hacs.json`. Add it as a **second** resource yourself: **Settings → Dashboards → ⋮ → Resources → Add Resource**, URL `/hacsfiles/lwz-thz-lovelace-cards/thz-schedule-card.js`, type **JavaScript Module**.

### Manual

1. Copy whichever card(s) you want — `thz-heating-curve-card.js` and/or `thz-schedule-card.js` — into `config/www/` on your Home Assistant instance.
2. Add each as its own Lovelace resource: **Settings → Dashboards → ⋮ → Resources → Add Resource**, URL `/local/thz-heating-curve-card.js` and/or `/local/thz-schedule-card.js`, type **JavaScript Module**.
3. Hard-refresh your browser.

## Heating Curve Card

It reads the curve parameters and live sensor values directly from your
entities, draws both the raw and room-influence-corrected curves, marks
the current operating point, and shows how far the device's actual
heat-set-temp has drifted from what the curve predicts — so you can tune
Gradient, Low End and Room Influence with immediate visual feedback.

### Features

- Live SVG plot of the heating curve (with and without room-influence correction), computed with the same formula used by the FHEM `THZ` module (`function_heatSetTemp`).
- A working-point marker plotted from your actual current outside temperature and heat-set-temp, with a thin dotted line down to the outside-temp scale so it's easy to read off.
- Gridlines every 5°C of outside temperature, plus a horizontal gridline at each y-axis step, to make the plot easier to read at a glance.
- Hover the chart to get a crosshair: move your mouse to any outside temperature and see exactly what flow temperature the curve would request there.
- A stats row: outside temperature, what the curve predicts, what the device reports, and the delta between them (flagged once it drifts 1.5 K or more).
- Editable number fields for Gradient, Low End and Room Influence. Typing a value never touches the device by itself — it only redraws the chart: your current settings stay plotted (dimmed) for comparison, a brighter preview curve shows what the new values would do, and an **Apply** button appears to actually send the change. **Discard** clears the edit without sending anything.
- Configurable text size for readability on different screens — `font_size` for the card, `axis_font_size` for the chart's axis labels.

### Usage

```yaml
type: custom:thz-heating-curve-card
title: HC1 Heating Curve
```

Gradient, Low End and Room Influence are editable number fields (not
+/- buttons). Typing a value only updates the chart — your currently-applied
curve stays visible but dimmed, and a brighter preview curve shows what the
typed value would produce, so you can compare the two before committing to
anything. Nothing is sent to the device until you click **Apply**, which
shows up (along with a summary of exactly what's changing) as soon as any
field differs from its live value; **Discard** reverts every field to its
live value without sending anything. If the underlying `number.*` entity
has `min`/`max`/`step` set, the field uses those (and Apply clamps to
`min`/`max` if you typed something outside range); otherwise it falls back
to the `step:` config below.

Text is small by default to fit a lot of chart in a small card. Two
separate settings control it, because the chart's axis labels live inside
an SVG that scales with the card's width rather than with regular CSS
text — bumping `font_size` alone won't grow them:

- `font_size` (pixels, default 15): the card's title, legend, stats and the parameter fields.
- `axis_font_size` (default 11): the chart's axis tick labels. The chart's margins grow automatically as this increases, so bigger labels don't get clipped.

```yaml
type: custom:thz-heating-curve-card
title: HC1 Heating Curve
font_size: 18
axis_font_size: 14
```

The default entity mapping matches the entity IDs produced by the
`lwz-thz-403` integration's FHEM-style naming, so no further
configuration is needed for a standard HC1 setup. To override any of
them (for example to target HC2, or if you've renamed entities):

```yaml
type: custom:thz-heating-curve-card
title: HC2 Heating Curve
entities:
  gradient: number.lwz403_p13_gradient_hc2
  low_end: number.lwz403_p14_low_end_hc2
  room_influence: number.lwz403_p15_room_influence_hc2
  room_set: climate.lwz403_heating_circuit_2
  inside_temp: sensor.lwz403_inside_temp
  outside_temp: sensor.lwz403_outside_temp_filtered
  heat_set_temp: sensor.lwz403_heat_set_temp
```

| Key | Default entity | Notes |
|---|---|---|
| `gradient` | `number.lwz403_p13_gradient_hc1` | Curve slope (P13) |
| `low_end` | `number.lwz403_p14_low_end_hc1` | Parallel offset in K (P14) |
| `room_influence` | `number.lwz403_p15_room_influence_hc1` | % (P15) |
| `room_set` | `climate.lwz403_heating_circuit` | Reads `attributes.temperature` if a `climate.*` entity, else its raw state |
| `inside_temp` | `sensor.lwz403_inside_temp` | |
| `outside_temp` | `sensor.lwz403_outside_temp_filtered` | |
| `heat_set_temp` | `sensor.lwz403_heat_set_temp` | Device's own computed target, for the delta comparison |

## Weekly Schedule Card

`custom:thz-schedule-card` edits the weekly **comfort** time windows for one
program family — HC1 heating, HC2 heating, DHW hot water, or Fan
ventilation — as a 7-day grid, three slots per day (matching the device's
own three program slots) — plus the **Day**, **Night** and **Standby**
setpoints that a comfort/setback window actually switches between (room
temperature for HC1/HC2, DHW temperature for DHW, fan stage for Fan), shown
above the grid so you can see and change both halves of the schedule in one
place.

### The model: comfort windows, not "setback windows"

The underlying registers (`programHC1_*`, `programDHW_*`, `programFan_*`,
...) each define a **comfort/day** window. Any time of day that isn't
covered by one of a day's (up to three) comfort windows falls back to
**setback** automatically — there is no separate "setback start/end"
entity to edit. So to get, say, a setback period of 22:00–06:00, you don't
enter that directly: you set a comfort window of 06:00–22:00 (or split
across two of the day's three slots) and let the device default the rest to
setback.

### Windows spanning midnight

A slot can cross midnight by setting its start time later than its end
time — e.g. 20:00 (start) → 02:00 (end) for a comfort window that runs
into the small hours. This is genuine, documented Stiebel Eltron firmware
behaviour (confirmed against the official operating manual: "Wenn Sie z.B.
für Montag eine Absenkzeit von 22:00 bis 6:00 einstellen, so beginnt die
Absenkung Montag um 22:00 und endet Dienstag um 6:00" — the device
explicitly interprets start > end as spanning into the next day), not a
workaround, so the card doesn't do anything special for it: just type the
times in either order.

### Individual weekdays only — a known, unresolved edge case

This card only reads and writes the seven **individual weekday** registers
per slot (`..._Mo_0`, `..._Tu_0`, ... `..._So_0`, and `_1`/`_2`). The
integration's register map separately exposes `Mo-Fr`/`Sa-So`/`Mo-So`
"group" registers at their own, independent addresses — these are a
convenience the device also offers, not an alias for the individual days.
Whether the device's firmware gives one of these two representations
priority if both are set and disagree for the same real day could not be
confirmed from the official documentation, the integration's source, or a
search of the FHEM/LWZ community forums. Because this card never writes to
the `Mo-Fr`/`Sa-So`/`Mo-So` registers itself, this only matters if you (or
a previous configuration) also set a group schedule via the device's own
menu or via those registers directly — if so, check the device's own menu
once to make sure nothing there conflicts with what you set here, or clear
it first.

### Prerequisites

The schedule grid's entities (every `program*` register, in all four
families) are hidden by default by the `lwz-thz-403` integration (its
"Entity visibility" option defaults to hiding schedule/program entities to
avoid cluttering a first-time setup). The three setpoint entities are
usually visible by default too — **except for HC2**, which the integration
treats as an advanced/HC2 entity and hides the same way. Before this card
can see everything it needs:

1. In the integration's options, set **Entity visibility** to **All** — the
   schedule grid itself needs this tier specifically; **Extended** only
   unhides advanced/HC2 entities (including the HC2 setpoints) and still
   hides every `program*` schedule entity.
2. Under **Settings → Devices & services → Entities**, search for
   `program_<family>` (e.g. `program_hc1`) and, for HC2, `hc2`, and enable
   any that are still disabled — changing the option above only affects
   entities created *after* the change, not ones already in the registry.

The card itself flags any entity it can't find with a banner naming the
setting above, so you don't have to guess why a field looks greyed out.

### Usage

```yaml
type: custom:thz-schedule-card
title: HC1 Heating Schedule
family: hc1
```

`family` just sets which program group the card *opens* on — `hc1`
(default), `hc2`, `dhw`, or `fan`. A dropdown in the card's own header lets
you switch between HC1/DHW/Fan afterwards without touching the dashboard
YAML (HC2 isn't in that dropdown, matching the integration's own default
scope, but `family: hc2` still works if you set it directly). If you have
pending, un-applied edits, switching is blocked with an explanation instead
of silently discarding them — apply or discard first.

Typing a time or a setpoint only stages the change (the field outlines and
a small "was ..." note appears below it) — nothing is sent until you click
**Apply**, which lists how many fields changed across both the schedule
grid and the setpoints row; **Discard** reverts everything back to the live
values. A setpoint typed outside its entity's `min`/`max` is clamped when
you click Apply, same as the heating curve card.

Apply sends changed fields to the device **one at a time**, not all at
once — deliberately. A slot's Start and End are two separate `time.*`
entities that share one physical register on the device, and writing both
at the same moment can collide on the wire (surfacing as a generic "Failed
to perform the action time/set_value" error). Sending them sequentially
means Apply can take a moment longer when several fields changed together,
but each write completes before the next starts. If Apply does still fail
partway through, whatever was already written is cleared from the pending
list; only the failed field and anything after it in the batch stay
staged, so you don't lose those edits or have to redo the ones that
succeeded.

```yaml
type: custom:thz-schedule-card
title: Ventilation Schedule
family: fan
```

```yaml
type: custom:thz-schedule-card
title: DHW Schedule
family: dhw
```

The default entity IDs follow the same FHEM-style naming as the heating
curve card, e.g. `time.lwz403_program_hc1_mo_0_start` for the schedule and
`number.lwz403_p01_room_temp_day_hc1` for the Day setpoint. If your setup
uses a different device alias than `lwz403`, override the prefix — it
applies to both the schedule and the setpoint entity IDs:

```yaml
type: custom:thz-schedule-card
title: HC1 Heating Schedule
family: hc1
entity_id_prefix: myalias
```

If your schedule entity IDs don't follow this pattern at all (for example,
you're on `entity_id_style: default` rather than `fhem`), override the
whole template — `{prefix}`, `{family}`, `{day}` (`mo`/`tu`/.../`so`),
`{slot}` (`0`/`1`/`2`) and `{part}` (`start`/`end`) are substituted in:

```yaml
type: custom:thz-schedule-card
title: HC1 Heating Schedule
family: hc1
entity_template: "time.{prefix}_program_{family}_{day}_{slot}_{part}"
```

The setpoint entity IDs aren't covered by `entity_template` (their names
don't follow the same `{family}`/`{day}`/`{slot}` shape as the schedule
registers) — override them individually with `entities` instead:

```yaml
type: custom:thz-schedule-card
title: HC1 Heating Schedule
family: hc1
entities:
  day: number.lwz403_p01_room_temp_day_hc1
  night: number.lwz403_p02_room_temp_night_hc1
  standby: number.lwz403_p03_room_temp_standby_hc1
```

| Key | Default | Notes |
|---|---|---|
| `family` | `hc1` | `hc1`, `hc2`, `dhw`, or `fan` |
| `slots` | `3` | Program slots per day (matches the device) |
| `entity_id_prefix` | `lwz403` | Device alias used in the default entity template and setpoint IDs |
| `entity_template` | `time.{prefix}_program_{family}_{day}_{slot}_{part}` | Full override for non-standard schedule entity IDs |
| `entities` | *(none)* | `{ day, night, standby }` overrides for the three setpoint entity IDs |
| `font_size` | `14` | Pixel font size for the card |

A slot can't be cleared back to "unset" from this card — Home Assistant's
`time.set_value` service requires a real time value, so there's no way to
send the device's "no time" sentinel through it. Clear a slot from the
device's own menu if you need that.

## Credit

Curve formula ported from the FHEM `00_THZ.pm` community module's
`function_heatSetTemp` / `THZ_PrintcurveSVG`. The comfort/setback and
midnight-crossing behaviour of the weekly schedule card is confirmed
against Stiebel Eltron's own LWZ operating manual.
