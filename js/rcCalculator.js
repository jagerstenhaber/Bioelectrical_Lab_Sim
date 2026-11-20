/**
 * Floating RC Filter Calculator Module
 * Computes cutoff frequency, resistance, or capacitance using f_c = 1 / (2 * pi * R * C).
 */

/**
 * Pure solver for the RC low-pass/high-pass cutoff equation f_c = 1 / (2 * pi * R * C).
 * @param {object} params
 * @param {number|null} [params.rSi] Resistance in Ohms
 * @param {number|null} [params.cSi] Capacitance in Farads
 * @param {number|null} [params.fSi] Cutoff frequency in Hertz
 * @param {'R'|'C'|'F'|null} [params.targetKey] Field to solve for (inferred if omitted and two others are valid)
 * @returns {number|null} Computed SI value for targetKey, or null if inputs are insufficient/invalid
 */
export function solveRcFilter({ rSi = null, cSi = null, fSi = null, targetKey = null } = {}) {
  const isPos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

  let resolvedTarget = targetKey;
  if (!resolvedTarget) {
    const missing = ['R', 'C', 'F'].filter((k) => {
      const val = k === 'R' ? rSi : k === 'C' ? cSi : fSi;
      return !isPos(val);
    });
    if (missing.length === 1) {
      resolvedTarget = missing[0];
    }
  }

  let targetSi = null;
  if (resolvedTarget === 'F' && isPos(rSi) && isPos(cSi)) {
    targetSi = 1 / (2 * Math.PI * rSi * cSi);
  } else if (resolvedTarget === 'R' && isPos(fSi) && isPos(cSi)) {
    targetSi = 1 / (2 * Math.PI * fSi * cSi);
  } else if (resolvedTarget === 'C' && isPos(fSi) && isPos(rSi)) {
    targetSi = 1 / (2 * Math.PI * fSi * rSi);
  }

  return isPos(targetSi) ? targetSi : null;
}

function formatRcNumber(val) {
  if (!Number.isFinite(val) || val <= 0) return '';
  if (val >= 0.01 && val < 100000) {
    return String(Number(val.toPrecision(4)));
  }
  return val.toExponential(3);
}

/**
 * Initializes the floating RC Filter Calculator UI and drag-to-move interactions.
 * @param {object} config
 * @param {HTMLElement} config.panelEl
 * @param {HTMLElement} config.headerEl
 * @param {HTMLElement} config.toggleBtn
 * @param {HTMLElement} config.clearBtn
 * @param {HTMLElement} config.closeBtn
 * @param {HTMLElement} config.canvasWrap
 * @param {{ R: { input: HTMLInputElement, unit: HTMLSelectElement, badge: HTMLElement }, C: { input: HTMLInputElement, unit: HTMLSelectElement, badge: HTMLElement }, F: { input: HTMLInputElement, unit: HTMLSelectElement, badge: HTMLElement } }} config.inputs
 */
export function initRcCalculator({
  panelEl,
  headerEl,
  toggleBtn,
  clearBtn,
  closeBtn,
  canvasWrap,
  inputs
}) {
  const fields = {
    R: inputs.R,
    C: inputs.C,
    F: inputs.F
  };

  let editHistory = [];
  let computedField = null;
  let dragState = null;

  const getSiValue = (key) => {
    const raw = fields[key].input.value.trim();
    if (raw === '') return null;
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) return null;
    return num * Number(fields[key].unit.value);
  };

  const updateBadges = () => {
    for (const k of ['R', 'C', 'F']) {
      const isComp = computedField === k;
      fields[k].badge.hidden = !isComp;
      const rowEl = fields[k].input.closest('.rc-calc-row');
      if (rowEl) rowEl.classList.toggle('is-computed', isComp);
    }
  };

  const recalculate = () => {
    // Determine which 2 fields are the active user inputs
    const validEdited = editHistory.filter((k) => getSiValue(k) !== null);
    let sourceKeys = validEdited.slice(-2);

    if (sourceKeys.length < 2) {
      // Fallback: check if any 2 fields (other than computedField) have valid positive values
      const candidates = ['R', 'C', 'F'].filter(
        (k) => k !== computedField && getSiValue(k) !== null
      );
      if (candidates.length === 2) {
        sourceKeys = candidates;
      } else {
        return;
      }
    }

    const targetKey = ['R', 'C', 'F'].find((k) => !sourceKeys.includes(k));
    if (!targetKey) return;

    const targetSi = solveRcFilter({
      rSi: getSiValue('R'),
      cSi: getSiValue('C'),
      fSi: getSiValue('F'),
      targetKey
    });

    if (targetSi !== null) {
      const targetUnitMult = Number(fields[targetKey].unit.value);
      const displayVal = targetSi / targetUnitMult;
      fields[targetKey].input.value = formatRcNumber(displayVal);
      computedField = targetKey;
      updateBadges();
    }
  };

  for (const key of ['R', 'C', 'F']) {
    fields[key].input.addEventListener('input', () => {
      const val = getSiValue(key);
      editHistory = editHistory.filter((k) => k !== key);
      if (val !== null) {
        editHistory.push(key);
        if (editHistory.length > 2) {
          editHistory.shift();
        }
        if (computedField === key) {
          computedField = null;
        }
        recalculate();
      } else if (computedField) {
        computedField = null;
        updateBadges();
      }
    });

    fields[key].unit.addEventListener('change', () => {
      recalculate();
    });
  }

  const clear = () => {
    fields.R.input.value = '';
    fields.C.input.value = '';
    fields.F.input.value = '';
    editHistory = [];
    computedField = null;
    updateBadges();
  };

  clearBtn.addEventListener('click', clear);

  closeBtn.addEventListener('click', () => {
    panelEl.hidden = true;
    toggleBtn?.classList.remove('active');
  });

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const willShow = panelEl.hidden;
      panelEl.hidden = !willShow;
      toggleBtn.classList.toggle('active', willShow);
    });
  }

  headerEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    const rect = panelEl.getBoundingClientRect();
    const parentRect = canvasWrap.getBoundingClientRect();
    dragState = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      origX: rect.left - parentRect.left,
      origY: rect.top - parentRect.top
    };
  });

  const onPointerMove = (e) => {
    if (!dragState) return;
    const { startClientX, startClientY, origX, origY } = dragState;
    const nx = Math.max(8, origX + (e.clientX - startClientX));
    const ny = Math.max(8, origY + (e.clientY - startClientY));
    panelEl.style.left = `${nx}px`;
    panelEl.style.top = `${ny}px`;
    panelEl.style.right = 'auto';
  };

  const onPointerUp = () => {
    if (dragState) {
      dragState = null;
    }
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  return {
    clear,
    recalculate,
    destroy() {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    }
  };
}
