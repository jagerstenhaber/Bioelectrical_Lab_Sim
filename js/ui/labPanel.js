/**
 * Left Sidebar "Lab" Tab Panel UI.
 * Supports loading external professor .json lab files (file picker or drag-and-drop),
 * browsing & downloading built-in demo labs, toggling the Lab Kit filter override,
 * and displaying live auto-evaluating step-by-step guidance checklists.
 */

export function createLabPanel({
  containerEl,
  onLoadLabJsonText = () => {},
  onSelectDemoLab = () => {},
  onDownloadDemoLab = () => {},
  onDownloadActiveLab = () => {},
  onToggleShowAll = () => {},
  onExitLab = () => {},
  onSelectStep = () => {},
  onToggleManualCheck = () => {}
} = {}) {
  if (!containerEl) {
    throw new Error('createLabPanel requires containerEl');
  }

  const ac = new AbortController();
  const { signal } = ac;

  let demoLabs = [];
  let activeLab = null;
  let lastEvaluation = null;
  let activeStepIndex = 0;
  let showAllOverride = false;
  let errorMessage = '';
  const expandedHints = new Set();

  // Track rendered lab structure so live simulation ticks patch checks in place
  let renderedLabKey = null;
  let checkDomMap = new Map(); // `${stepIdx}:${checkIdx}` -> { rowEl, iconEl, detailEl, checkboxEl }
  let stepDomMap = new Map(); // stepIdx -> { cardEl, statusEl, headBtnEl, bodyEl, hintBtnEl, hintBoxEl }
  let activeDomRefs = null;

  const rootEl = document.createElement('div');
  rootEl.className = 'lab-panel-scroll';
  containerEl.innerHTML = '';
  containerEl.appendChild(rootEl);

  // Shared hidden file input for custom lab .json upload
  const fileInputEl = document.createElement('input');
  fileInputEl.type = 'file';
  fileInputEl.accept = '.json,application/json';
  fileInputEl.hidden = true;
  fileInputEl.dataset.labFileInput = '';
  containerEl.appendChild(fileInputEl);

  function readAndSubmitFile(file) {
    if (!file) return;
    if (typeof file.text === 'function') {
      file.text().then(
        (text) => onLoadLabJsonText(text, file.name),
        () => setError('Could not read the selected file.')
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => onLoadLabJsonText(String(reader.result || ''), file.name);
    reader.onerror = () => setError('Could not read the selected file.');
    reader.readAsText(file);
  }

  fileInputEl.addEventListener(
    'change',
    () => {
      const file = fileInputEl.files?.[0];
      fileInputEl.value = '';
      if (file) {
        readAndSubmitFile(file);
      }
    },
    { signal }
  );

  function setError(msg) {
    errorMessage = typeof msg === 'string' ? msg.trim() : '';
    const errEl = rootEl.querySelector('[data-lab-error]');
    if (errEl) {
      errEl.textContent = errorMessage;
      errEl.hidden = !errorMessage;
    } else if (errorMessage) {
      renderFull();
    }
  }

  function describeKitSummary(lab) {
    if (!lab?.filters) return '';
    const parts = [];
    if (Array.isArray(lab.filters.allowedParts)) {
      parts.push(`${lab.filters.allowedParts.length} parts`);
    }
    if (Array.isArray(lab.filters.allowedSensors)) {
      parts.push(
        lab.filters.allowedSensors.length === 0
          ? 'no ext. sensors'
          : `${lab.filters.allowedSensors.length} sensor${lab.filters.allowedSensors.length === 1 ? '' : 's'}`
      );
    }
    if (Array.isArray(lab.filters.allowedInstruments)) {
      parts.push(
        `${lab.filters.allowedInstruments.length} instrument${lab.filters.allowedInstruments.length === 1 ? '' : 's'}`
      );
    }
    return parts.join(' · ');
  }

  function hasAnyKitFilter(lab) {
    if (!lab?.filters) return false;
    return (
      Array.isArray(lab.filters.allowedParts) ||
      Array.isArray(lab.filters.allowedSensors) ||
      Array.isArray(lab.filters.allowedInstruments)
    );
  }

  function buildErrorBanner() {
    const errEl = document.createElement('div');
    errEl.className = 'lab-error-box';
    errEl.dataset.labError = '';
    errEl.setAttribute('role', 'alert');
    errEl.textContent = errorMessage;
    errEl.hidden = !errorMessage;
    return errEl;
  }

  function renderLauncherView() {
    renderedLabKey = null;
    checkDomMap.clear();
    stepDomMap.clear();
    activeDomRefs = null;
    rootEl.innerHTML = '';

    // Custom Lab Upload / Dropzone Card
    const uploadCard = document.createElement('section');
    uploadCard.className = 'lab-upload-card';
    uploadCard.dataset.labDropzone = '';

    const uploadTitle = document.createElement('div');
    uploadTitle.className = 'lab-upload-title';
    uploadTitle.textContent = '📂 Load Custom Lab File';

    const uploadDesc = document.createElement('p');
    uploadDesc.className = 'lab-upload-desc';
    uploadDesc.textContent =
      'Load a professor-authored .json lab guide with step instructions, live checks, and filtered part kits.';

    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'lab-primary-btn';
    uploadBtn.dataset.labUploadBtn = '';
    uploadBtn.textContent = '⬆ Choose Lab .json File';
    uploadBtn.addEventListener('click', () => fileInputEl.click(), { signal });

    const dropHint = document.createElement('div');
    dropHint.className = 'lab-drop-hint';
    dropHint.textContent = 'or drag & drop a .json file here';

    uploadCard.addEventListener(
      'dragover',
      (e) => {
        e.preventDefault();
        uploadCard.classList.add('is-dragover');
      },
      { signal }
    );
    uploadCard.addEventListener(
      'dragleave',
      () => {
        uploadCard.classList.remove('is-dragover');
      },
      { signal }
    );
    uploadCard.addEventListener(
      'drop',
      (e) => {
        e.preventDefault();
        uploadCard.classList.remove('is-dragover');
        const file = e.dataTransfer?.files?.[0];
        if (file) {
          readAndSubmitFile(file);
        }
      },
      { signal }
    );

    uploadCard.append(uploadTitle, uploadDesc, uploadBtn, dropHint);
    rootEl.appendChild(uploadCard);
    rootEl.appendChild(buildErrorBanner());

    // Downloadable Demo Labs section
    const heading = document.createElement('div');
    heading.className = 'sensors-section-heading';
    heading.textContent = 'Demo Labs (Download & Customize)';
    rootEl.appendChild(heading);

    const listEl = document.createElement('div');
    listEl.className = 'lab-demo-list';

    for (const demo of demoLabs) {
      const card = document.createElement('section');
      card.className = 'lab-demo-card';
      card.dataset.demoLabId = demo.id;

      const title = document.createElement('h3');
      title.className = 'lab-demo-title';
      title.textContent = demo.title;

      const metaRow = document.createElement('div');
      metaRow.className = 'lab-demo-meta';
      if (demo.course) {
        const courseEl = document.createElement('span');
        courseEl.className = 'lab-demo-course';
        courseEl.textContent = demo.course;
        metaRow.appendChild(courseEl);
      }
      if (demo.kitBadge) {
        const badgeEl = document.createElement('span');
        badgeEl.className = 'lab-demo-kit';
        badgeEl.textContent = demo.kitBadge;
        metaRow.appendChild(badgeEl);
      }

      const summary = document.createElement('p');
      summary.className = 'lab-demo-summary';
      summary.textContent = demo.summary || '';

      const actions = document.createElement('div');
      actions.className = 'lab-demo-actions';

      const loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.className = 'lab-load-btn';
      loadBtn.dataset.loadDemoLab = demo.id;
      loadBtn.textContent = '▶ Load Lab';
      loadBtn.addEventListener('click', () => onSelectDemoLab(demo.id), { signal });

      const dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.className = 'lab-ghost-btn';
      dlBtn.dataset.downloadDemoLab = demo.id;
      dlBtn.title = `Download ${demo.file || `${demo.id}.json`} as a customizable template`;
      dlBtn.textContent = '⬇ .json';
      dlBtn.addEventListener('click', () => onDownloadDemoLab(demo.id), { signal });

      actions.append(loadBtn, dlBtn);
      card.append(title, metaRow, summary, actions);
      listEl.appendChild(card);
    }

    rootEl.appendChild(listEl);

    const footerNote = document.createElement('div');
    footerNote.className = 'sensors-footer-note';
    footerNote.innerHTML =
      '<strong>Instructors:</strong> Download any demo <code>.json</code> to customize steps, live checks, or filtered kits, or link directly via <code>?lab=./labs/file.json</code>.';
    rootEl.appendChild(footerNote);
  }

  function renderActiveLabSkeleton() {
    renderedLabKey = `${activeLab.id}::${activeLab.steps.length}`;
    checkDomMap.clear();
    stepDomMap.clear();
    rootEl.innerHTML = '';

    // Active Lab Header Card
    const headerCard = document.createElement('section');
    headerCard.className = 'lab-active-header';
    headerCard.dataset.activeLabId = activeLab.id;

    if (activeLab.course || activeLab.author) {
      const metaEl = document.createElement('div');
      metaEl.className = 'lab-active-meta';
      metaEl.textContent = [activeLab.course, activeLab.author].filter(Boolean).join(' · ');
      headerCard.appendChild(metaEl);
    }

    const titleEl = document.createElement('h3');
    titleEl.className = 'lab-active-title';
    titleEl.textContent = activeLab.title;
    headerCard.appendChild(titleEl);

    if (activeLab.description) {
      const descEl = document.createElement('p');
      descEl.className = 'lab-active-desc';
      descEl.textContent = activeLab.description;
      headerCard.appendChild(descEl);
    }

    // Progress Bar
    const progressWrap = document.createElement('div');
    progressWrap.className = 'lab-progress-wrap';

    const progressHead = document.createElement('div');
    progressHead.className = 'lab-progress-head';

    const progressLabel = document.createElement('span');
    progressLabel.className = 'lab-progress-label';
    progressLabel.dataset.labProgressLabel = '';

    const progressPct = document.createElement('span');
    progressPct.className = 'lab-progress-pct';
    progressPct.dataset.labProgressPct = '';

    progressHead.append(progressLabel, progressPct);

    const progressTrack = document.createElement('div');
    progressTrack.className = 'lab-progress-track';
    const progressFill = document.createElement('div');
    progressFill.className = 'lab-progress-fill';
    progressFill.dataset.labProgressFill = '';
    progressTrack.appendChild(progressFill);

    progressWrap.append(progressHead, progressTrack);
    headerCard.appendChild(progressWrap);

    // Kit Filter Override Row (only when lab defines filters)
    let kitRow = null;
    let kitTextEl = null;
    let kitToggleBtn = null;
    if (hasAnyKitFilter(activeLab)) {
      kitRow = document.createElement('div');
      kitRow.className = 'lab-kit-bar';
      kitRow.dataset.labKitBar = '';

      kitTextEl = document.createElement('span');
      kitTextEl.className = 'lab-kit-text';

      kitToggleBtn = document.createElement('button');
      kitToggleBtn.type = 'button';
      kitToggleBtn.className = 'lab-kit-toggle-btn';
      kitToggleBtn.dataset.labToggleShowAll = '';
      kitToggleBtn.addEventListener('click', () => onToggleShowAll(!showAllOverride), { signal });

      kitRow.append(kitTextEl, kitToggleBtn);
      headerCard.appendChild(kitRow);
    }

    // Action Buttons Row
    const actionsRow = document.createElement('div');
    actionsRow.className = 'lab-active-actions';

    const loadAnotherBtn = document.createElement('button');
    loadAnotherBtn.type = 'button';
    loadAnotherBtn.className = 'lab-ghost-btn';
    loadAnotherBtn.title = 'Load a different custom .json lab file';
    loadAnotherBtn.textContent = '⬆ Load .json';
    loadAnotherBtn.addEventListener('click', () => fileInputEl.click(), { signal });

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'lab-ghost-btn';
    dlBtn.dataset.labDownloadActive = '';
    dlBtn.title = 'Download this lab as a .json template';
    dlBtn.textContent = '⬇ .json';
    dlBtn.addEventListener('click', () => onDownloadActiveLab(), { signal });

    const exitBtn = document.createElement('button');
    exitBtn.type = 'button';
    exitBtn.className = 'lab-exit-btn';
    exitBtn.dataset.labExitBtn = '';
    exitBtn.title = 'Exit active lab and restore all parts, sensors, and instruments';
    exitBtn.textContent = '✕ Exit Lab';
    exitBtn.addEventListener('click', () => onExitLab(), { signal });

    actionsRow.append(loadAnotherBtn, dlBtn, exitBtn);
    headerCard.appendChild(actionsRow);

    rootEl.appendChild(headerCard);
    rootEl.appendChild(buildErrorBanner());

    // Steps List
    const stepsWrap = document.createElement('div');
    stepsWrap.className = 'lab-steps-list';

    activeLab.steps.forEach((step, stepIdx) => {
      const card = document.createElement('section');
      card.className = 'lab-step-card';
      card.dataset.labStepIndex = String(stepIdx);

      const headBtn = document.createElement('button');
      headBtn.type = 'button';
      headBtn.className = 'lab-step-head';
      headBtn.dataset.labStepBtn = String(stepIdx);

      const numSpan = document.createElement('span');
      numSpan.className = 'lab-step-num';
      numSpan.textContent = String(stepIdx + 1);

      const titleSpan = document.createElement('span');
      titleSpan.className = 'lab-step-title';
      titleSpan.textContent = step.title;

      const statusSpan = document.createElement('span');
      statusSpan.className = 'lab-step-status';
      statusSpan.dataset.labStepStatus = String(stepIdx);

      headBtn.append(numSpan, titleSpan, statusSpan);
      headBtn.addEventListener('click', () => onSelectStep(stepIdx), { signal });

      const bodyEl = document.createElement('div');
      bodyEl.className = 'lab-step-body';

      if (step.instruction) {
        const instEl = document.createElement('p');
        instEl.className = 'lab-step-instruction';
        instEl.textContent = step.instruction;
        bodyEl.appendChild(instEl);
      }

      let hintBtnEl = null;
      let hintBoxEl = null;
      if (step.hint) {
        const hintKey = `${activeLab.id}::${step.id}`;
        hintBtnEl = document.createElement('button');
        hintBtnEl.type = 'button';
        hintBtnEl.className = 'lab-hint-toggle';
        hintBtnEl.dataset.labHintToggle = String(stepIdx);
        const isOpen = expandedHints.has(hintKey);
        hintBtnEl.textContent = isOpen ? '💡 Hide Hint' : '💡 Show Hint';
        hintBtnEl.setAttribute('aria-expanded', String(isOpen));

        hintBoxEl = document.createElement('div');
        hintBoxEl.className = 'lab-hint-box';
        hintBoxEl.textContent = step.hint;
        hintBoxEl.hidden = !isOpen;

        hintBtnEl.addEventListener(
          'click',
          () => {
            if (expandedHints.has(hintKey)) {
              expandedHints.delete(hintKey);
            } else {
              expandedHints.add(hintKey);
            }
            const nextOpen = expandedHints.has(hintKey);
            hintBoxEl.hidden = !nextOpen;
            hintBtnEl.textContent = nextOpen ? '💡 Hide Hint' : '💡 Show Hint';
            hintBtnEl.setAttribute('aria-expanded', String(nextOpen));
          },
          { signal }
        );

        bodyEl.append(hintBtnEl, hintBoxEl);
      }

      // Live Checks
      const checksList = document.createElement('div');
      checksList.className = 'lab-checks-list';

      (step.checks || []).forEach((chk, checkIdx) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'lab-check-row';
        rowEl.dataset.labCheck = `${stepIdx}:${checkIdx}`;

        let iconEl = null;
        let checkboxEl = null;

        if (chk.type === 'manual-check') {
          rowEl.classList.add('is-manual');
          const manualKey = `${step.id}::${chk.id}`;
          checkboxEl = document.createElement('input');
          checkboxEl.type = 'checkbox';
          checkboxEl.className = 'lab-manual-checkbox';
          checkboxEl.dataset.manualKey = manualKey;
          checkboxEl.addEventListener(
            'change',
            () => onToggleManualCheck(manualKey, checkboxEl.checked),
            { signal }
          );
          rowEl.appendChild(checkboxEl);
        } else {
          iconEl = document.createElement('span');
          iconEl.className = 'lab-check-icon';
          iconEl.setAttribute('aria-hidden', 'true');
          iconEl.textContent = '○';
          rowEl.appendChild(iconEl);
        }

        const textWrap = document.createElement('div');
        textWrap.className = 'lab-check-body';

        const labelEl = document.createElement(chk.type === 'manual-check' ? 'label' : 'div');
        labelEl.className = 'lab-check-label';
        labelEl.textContent = chk.label;
        if (checkboxEl) {
          const cbId = `lab-manual-${stepIdx}-${checkIdx}`;
          checkboxEl.id = cbId;
          labelEl.setAttribute('for', cbId);
        }

        const detailEl = document.createElement('div');
        detailEl.className = 'lab-check-detail';

        textWrap.append(labelEl, detailEl);
        rowEl.appendChild(textWrap);
        checksList.appendChild(rowEl);

        checkDomMap.set(`${stepIdx}:${checkIdx}`, {
          rowEl,
          iconEl,
          detailEl,
          checkboxEl
        });
      });

      bodyEl.appendChild(checksList);

      // Step Navigation Footer
      const navRow = document.createElement('div');
      navRow.className = 'lab-step-nav';

      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'lab-nav-btn';
      prevBtn.textContent = '◀ Prev';
      prevBtn.disabled = stepIdx === 0;
      prevBtn.addEventListener('click', () => onSelectStep(Math.max(0, stepIdx - 1)), { signal });

      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'lab-nav-btn is-next';
      nextBtn.textContent = stepIdx === activeLab.steps.length - 1 ? 'Done ✓' : 'Next ▶';
      nextBtn.disabled = stepIdx === activeLab.steps.length - 1;
      nextBtn.addEventListener(
        'click',
        () => onSelectStep(Math.min(activeLab.steps.length - 1, stepIdx + 1)),
        { signal }
      );

      navRow.append(prevBtn, nextBtn);
      bodyEl.appendChild(navRow);

      card.append(headBtn, bodyEl);
      stepsWrap.appendChild(card);

      stepDomMap.set(stepIdx, {
        cardEl: card,
        statusEl: statusSpan,
        headBtnEl: headBtn,
        bodyEl,
        hintBtnEl,
        hintBoxEl
      });
    });

    rootEl.appendChild(stepsWrap);

    activeDomRefs = {
      progressLabel,
      progressPct,
      progressFill,
      kitRow,
      kitTextEl,
      kitToggleBtn
    };
  }

  function patchActiveLabDom() {
    if (!activeLab || !activeDomRefs) return;

    const ev = lastEvaluation;
    const totalChecks = ev?.totalChecks || 0;
    const passedChecks = ev?.passedChecks || 0;
    const pct = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 0;
    const allPassed = Boolean(ev?.allPassed);

    activeDomRefs.progressLabel.textContent = allPassed
      ? `🎉 Lab Complete (${passedChecks}/${totalChecks})`
      : `${passedChecks} / ${totalChecks} checks · Step ${activeStepIndex + 1} of ${activeLab.steps.length}`;
    activeDomRefs.progressLabel.classList.toggle('is-complete', allPassed);
    activeDomRefs.progressPct.textContent = `${pct}%`;
    activeDomRefs.progressFill.style.width = `${pct}%`;
    activeDomRefs.progressFill.classList.toggle('is-complete', allPassed);

    if (activeDomRefs.kitRow && activeDomRefs.kitTextEl && activeDomRefs.kitToggleBtn) {
      activeDomRefs.kitRow.classList.toggle('is-overridden', showAllOverride);
      activeDomRefs.kitTextEl.textContent = showAllOverride
        ? 'All parts & instruments shown'
        : `Kit Filter: ${describeKitSummary(activeLab)}`;
      activeDomRefs.kitToggleBtn.textContent = showAllOverride ? 'Re-apply Kit' : 'Show All';
      activeDomRefs.kitToggleBtn.setAttribute('aria-pressed', String(showAllOverride));
    }

    const evalSteps = ev?.steps || [];
    for (let sIdx = 0; sIdx < activeLab.steps.length; sIdx++) {
      const refs = stepDomMap.get(sIdx);
      if (!refs) continue;
      const stepEv = evalSteps[sIdx];
      const isExpanded = sIdx === activeStepIndex;
      const isComplete = Boolean(stepEv?.complete);

      refs.cardEl.classList.toggle('is-active', isExpanded);
      refs.cardEl.classList.toggle('is-complete', isComplete);
      refs.bodyEl.hidden = !isExpanded;
      refs.headBtnEl.setAttribute('aria-expanded', String(isExpanded));

      if (stepEv) {
        refs.statusEl.textContent = isComplete
          ? '✓'
          : `${stepEv.passedCount}/${stepEv.totalCount}`;
        refs.statusEl.classList.toggle('is-complete', isComplete);

        stepEv.checks.forEach((chkEv, cIdx) => {
          const cRefs = checkDomMap.get(`${sIdx}:${cIdx}`);
          if (!cRefs) return;
          cRefs.rowEl.classList.toggle('is-pass', Boolean(chkEv.passed));
          if (cRefs.iconEl) {
            cRefs.iconEl.textContent = chkEv.passed ? '✓' : '○';
          }
          if (cRefs.checkboxEl) {
            cRefs.checkboxEl.checked = Boolean(chkEv.passed);
          }
          if (cRefs.detailEl) {
            cRefs.detailEl.textContent = chkEv.detail || '';
            cRefs.detailEl.hidden = !chkEv.detail;
          }
        });
      }
    }
  }

  function renderFull() {
    if (!activeLab) {
      renderLauncherView();
      return;
    }
    const nextKey = `${activeLab.id}::${activeLab.steps.length}`;
    if (renderedLabKey !== nextKey) {
      renderActiveLabSkeleton();
    }
    patchActiveLabDom();
  }

  function setDemoLabs(list) {
    demoLabs = Array.isArray(list) ? list : [];
    if (!activeLab) {
      renderLauncherView();
    }
  }

  function update({
    lab = null,
    evaluation = null,
    stepIndex = 0,
    showAll = false,
    error = undefined
  } = {}) {
    activeLab = lab;
    lastEvaluation = evaluation;
    activeStepIndex = activeLab
      ? Math.min(Math.max(0, stepIndex), Math.max(0, activeLab.steps.length - 1))
      : 0;
    showAllOverride = Boolean(showAll);
    if (error !== undefined) {
      errorMessage = typeof error === 'string' ? error.trim() : '';
    }
    renderFull();
  }

  function openFilePicker() {
    fileInputEl.click();
  }

  function destroy() {
    ac.abort();
    checkDomMap.clear();
    stepDomMap.clear();
    activeDomRefs = null;
    containerEl.innerHTML = '';
  }

  renderLauncherView();

  return {
    setDemoLabs,
    update,
    setError,
    openFilePicker,
    destroy
  };
}
