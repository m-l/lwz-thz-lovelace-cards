# THZ Heating Curve Card

A Home Assistant Lovelace card that plots the live heating curve for a
Stiebel Eltron / Tecalor LWZ/THZ heat pump originally managed by the
[`lwz-thz-403`](https://github.com/m-l/lwz-thz-403) integration.

<img width="496" height="463" alt="image" src="https://github.com/user-attachments/assets/157f46fc-793f-470e-a749-5141c55cfe8b" />

It reads the curve parameters and live sensor values directly from your
entities, draws both the raw and room-influence-corrected curves, marks
the current operating point, and shows how far the device's actual
heat-set-temp has drifted from what the curve predicts — so you can tune
Gradient, Low End and Room Influence with immediate visual feedback.

## Features

- Live SVG plot of the heating curve (with and without room-influence correction), computed with the same formula used by the FHEM `THZ` module (`function_heatSetTemp`).
- A working-point marker plotted from your actual current outside temperature and heat-set-temp, with a thin dotted line down to the outside-temp scale so it's easy to read off.
- Gridlines every 5°C of outside temperature, plus a horizontal gridline at each y-axis step, to make the plot easier to read at a glance.
- Hover the chart to get a crosshair: move your mouse to any outside temperature and see exactly what flow temperature the curve would request there.
- A stats row: outside temperature, what the curve predicts, what the device reports, and the delta between them (flagged once it drifts 1.5 K or more).
- Editable number fields for Gradient, Low End and Room Influence that call `number.set_value` directly, so you can type a new value and watch the curve move without leaving the dashboard.
- Configurable text size for readability on different screens — `font_size` for the card, `axis_font_size` for the chart's axis labels.

## Installation

### HACS (recommended)

1. In Home Assistant, go to **HACS → ⋮ (top right) → Custom repositories**.
2. Add `https://github.com/m-l/lwz-thz-heating-curve-lovelace`, category **Dashboard**.
3. Find **THZ Heating Curve Card** in HACS and install it.
4. HACS registers the Lovelace resource for you. If the card doesn't show up in the card picker, add it manually under **Settings → Dashboards → Resources**: URL `/hacsfiles/lwz-thz-heating-curve-lovelace/thz-heating-curve-card.js`, type **JavaScript Module** — then hard-refresh your browser.

### Manual

1. Copy `thz-heating-curve-card.js` into `config/www/` on your Home Assistant instance.
2. Add it as a Lovelace resource: **Settings → Dashboards → ⋮ → Resources → Add Resource**, URL `/local/thz-heating-curve-card.js`, type **JavaScript Module**.
3. Hard-refresh your browser.

## Usage

```yaml
type: custom:thz-heating-curve-card
title: HC1 Heating Curve
```

Gradient, Low End and Room Influence are editable number fields (not
+/- buttons) — type a value and press Enter or click away to send it.
If the underlying `number.*` entity has `min`/`max`/`step` set, the field
uses those; otherwise it falls back to the `step:` config below.

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

## Credit

Curve formula ported from the FHEM `00_THZ.pm` community module's
`function_heatSetTemp` / `THZ_PrintcurveSVG`.
