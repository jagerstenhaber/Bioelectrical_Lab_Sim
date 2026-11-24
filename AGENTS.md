# AI Agents & Skills Directory (`AGENTS.md`)

This repository includes preconfigured agent definitions (`.agents/agents/`) and reusable step-by-step skills (`.agents/skills/`) so AI coding assistants and human maintainers can reliably generate new parts, author guided labs, audit physics/isolation accuracy, and catch UI/layout regressions.

---

## 1. Specialized Agent Roster (`.agents/agents/`)

| Agent Name | Definition File | When to Invoke |
|---|---|---|
| **`part_and_lab_author`** | [`.agents/agents/part_and_lab_author/agent.md`](./.agents/agents/part_and_lab_author/agent.md) | Creating new breadboard components (`parts/<part-id>/`), authoring or customizing guided lab `.json` files (`labs/<lab-id>.json`), or adding new classroom demo presets (`js/presets.js`) while maintaining 100% offline `file://` parity. |
| **`physics_and_isolation_qa`** | [`.agents/agents/physics_and_isolation_qa/agent.md`](./.agents/agents/physics_and_isolation_qa/agent.md) | Testing or debugging DC MNA, Backward-Euler transient RC filtering, AC Bode sweeps, LED-coupled PPG / dual-wavelength Pulse-Ox, ARB EKG synthesis, Arduino `analogRead()` live capacitor stepping, or **IEC 60601** patient isolation barriers. |
| **`ui_and_usability_qa`** | [`.agents/agents/ui_and_usability_qa/agent.md`](./.agents/agents/ui_and_usability_qa/agent.md) | Running headless Chromium (`1280×720`) viewport & layout checks (`0px` outer scroll, `[hidden]` CSS compliance, non-overlapping canvas pills, kit filtering, touch pinch-zoom) and 3-persona student/professor usability verification. |
| **`maintainability_supervisor`** | [`.agents/agents/maintainability_supervisor/agent.md`](./.agents/agents/maintainability_supervisor/agent.md) | Architectural review before merging a PR: enforces zero-DOM `js/sim/*` boundaries, two-tier render path separation, v4/v5 persistence compatibility, and `npm run audit` parity. |

---

## 2. Prebuilt Skills Library (`.agents/skills/`)

Agents (and developers) should consult these skills before performing common repetitive tasks:

| Skill Name | Skill Path | Purpose |
|---|---|---|
| **`part-builder`** | [`.agents/skills/part-builder/SKILL.md`](./.agents/skills/part-builder/SKILL.md) | End-to-end checklist & templates for creating a `two-lead` or `footprint` breadboard component (`part.json`, `graphic.svg`, `parts/manifest.json`, `OFFLINE_PARTS_CATALOG` in `js/partsLoader.js`, and optional solver hooks). |
| **`lab-builder`** | [`.agents/skills/lab-builder/SKILL.md`](./.agents/skills/lab-builder/SKILL.md) | End-to-end checklist & templates for authoring a professor-customizable guided lab (`labs/<id>.json`), configuring kit filters (`allowedParts`, `allowedSensors`, `allowedInstruments`), choosing from the 15 live check types, and syncing `js/labLoader.js`. |
| **`sim-diagnostics`** | [`.agents/skills/sim-diagnostics/SKILL.md`](./.agents/skills/sim-diagnostics/SKILL.md) | Playbook for diagnosing and testing common circuit & bioelectrical simulation bugs (multi-frequency RC attenuation, Backward-Euler sub-stepping, live Arduino capacitor stepping, IEC 60601 bridged grounds, and optical PPG coupling). |
| **`verify-ui`** | [`.agents/skills/verify-ui/SKILL.md`](./.agents/skills/verify-ui/SKILL.md) | Repeatable headless Chromium (`1280×720`) CDP verification pattern testing outer scroll, `[hidden]` CSS overrides, pill non-overlap, kit filtering, and zero console errors. |

---

## 3. Standard Task Routing & Verification Workflow

For any change to this repository:

1. **Read [`MAINTENANCE.md`](./MAINTENANCE.md)** and the matching skill in `.agents/skills/<skill>/SKILL.md`.
2. **Work on a Feature Branch**:
   - Never push directly to `main`. Create a descriptive branch (`git checkout -b feat/<topic> origin/main`) and open a Pull Request.
3. **Run the Automated Gates Before Opening a PR**:
   ```bash
   npm run audit
   npm test
   ```
   - `npm run audit` executes [`scripts/audit-repo.mjs`](./scripts/audit-repo.mjs), which checks ES module syntax across every `.js` file, verifies `parts/manifest.json` ↔ `js/partsLoader.js` parity, verifies `labs/manifest.json` ↔ `js/labLoader.js` parity, validates every `labs/*.json` file and kit filter ID, and verifies all 14 `LAB_PRESETS`.
   - `npm test` runs all 160+ Node unit and integration tests across DC, Transient, AC Bode, EMG, PPG/Pulse-Ox, ARB EKG, Arduino Runtime, IEC 60601 Isolation, and Guided Lab evaluation.
4. **Run Headless Chromium UI Verification (For UI / CSS / Layout / Lab Changes)**:
   - Follow [`.agents/skills/verify-ui/SKILL.md`](./.agents/skills/verify-ui/SKILL.md) at `1280×720` and inspect captured screenshots to confirm `0` console errors and `0px` outer scroll.
