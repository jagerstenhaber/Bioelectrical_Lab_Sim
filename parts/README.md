# Parts Directory Guide

Every component in the catalog lives in its own subfolder inside `parts/` and is registered in [`parts/manifest.json`](./manifest.json).

Because the site runs directly on GitHub Pages without a backend server, `parts/manifest.json` lists the folder names to load at startup.

## Folder Structure

```text
parts/
├── manifest.json           # List of part folder IDs to load
├── README.md               # This guide
├── arduino-nano/
│   ├── part.json           # Pinout, footprint, and metadata
│   └── graphic.svg         # Component body illustration (SVG)
├── cap-100nf/
│   ├── part.json
│   └── graphic.svg
└── resistor-1k/
    ├── part.json
    └── graphic.svg
```

## How to Add a New Part

1. **Create a new folder** under `parts/<your-part-id>/`.
2. **Add `part.json`** inside that folder:
   - **Two-lead flexible parts** (`"placement": "two-lead"`): Specify `defaultSpan` (in breadboard hole pitches, where `1` pitch = `16px`), `bodyWidth`, `bodyHeight`, and pin names. The simulator automatically draws stretchable metallic leads from the two breadboard holes to the ends of `graphic.svg` and rotates the body to sit cleanly between the pins.
   - **Multi-pin fixed footprint parts** (`"placement": "footprint"`): Specify `widthPitches`, `heightPitches`, and an array of `pins` with `dx` and `dy` grid offsets (in hole pitches relative to Pin 1 at `[0, 0]`).
3. **Add `graphic.svg`** inside that folder for the visual body of the component.
4. **Register the folder** by adding `"<your-part-id>"` to the `"parts"` array in `parts/manifest.json`.
