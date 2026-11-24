---
name: verify-ui
description: Repeatable headless Chromium (1280x720) verification pattern for testing layout invariants, 0px outer scroll, [hidden] CSS rules, non-overlapping canvas pills, kit filtering, and zero console errors.
---

# Headless Chromium UI & Usability Verification (`verify-ui`)

Use this skill after any HTML, CSS, workspace layout, sidebar, instrument panel, or guided lab UI change to verify visual and functional quality at `1280×720`.

## 1. Environment & Launch Rules

- **Chromium Binary**: `/usr/bin/chromium`
- **Mandatory Flags in This Environment**:
  - `--headless=new --disable-gpu --no-sandbox --disable-dev-shm-usage`
  - `--proxy-bypass-list=127.0.0.1;localhost` *(critical so Chromium connects directly to your local `127.0.0.1` HTTP server and CDP port)*
  - `--remote-debugging-port=<PORT> --window-size=1280,720`
- **Exact Viewport Override via CDP**:
  Always send `Emulation.setDeviceMetricsOverride({ width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })` before running layout assertions.

## 2. Core UI Invariants to Assert

1. **Zero Outer Document Scroll at `1280×720`**:
   ```js
   const html = document.documentElement;
   assert(html.scrollWidth <= window.innerWidth + 1);
   assert(html.scrollHeight <= window.innerHeight + 1);
   ```
2. **Single-Row Topbar (`47px`), 3-Tab Sidebar Header, and 1-Row Dock Tabs**:
   - `#sidebar-tabs` (`Parts | Sensors | Lab`) must have `scrollWidth <= clientWidth + 1`.
   - `[data-dock-tabs]` must fit all visible instrument tabs on 1 row (`clientHeight <= 36`).
3. **CSS `[hidden]` Compliance**:
   - Never rely solely on `!el.hidden` in DOM checks—always verify `getComputedStyle(el).display === 'none'` when `el.hidden === true` (especially for flex/grid items like `.dock-rail-btn`, `.dock-tab-btn`, `.sensor-card`, `.isolation-card`, `.lab-filter-banner`).
4. **Non-Overlapping Canvas Floating Overlays**:
   - Verify bounding boxes of visible canvas overlays (`#lab-step-bar`, `#isolation-safety-pill`, `#short-warning-banner`, `#probe-mode-banner`, `#selection-inspector`, `.zoom-controls`) have **0px intersection**.
5. **Zero Console Errors / Warnings / Uncaught Exceptions**:
   - Enable `Runtime.enable` and `Console.enable` over CDP and assert `0` `Runtime.exceptionThrown` events and `0` `error`/`warning` console messages across all interactions.
6. **Visual Screenshot Inspection**:
   - Capture PNG screenshots via `Page.captureScreenshot` and inspect them with `view_file` to confirm visual contrast, alignment, and readability.
