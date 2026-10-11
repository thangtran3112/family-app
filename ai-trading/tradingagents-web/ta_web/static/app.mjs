const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIXES = new Set(['', '/u/tradingagents']);
const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const REPORT_FIELDS = [
  ['market_report', 'Market analysis'],
  ['sentiment_report', 'Sentiment analysis'],
  ['news_report', 'News analysis'],
  ['fundamentals_report', 'Fundamentals analysis'],
  ['investment_plan', 'Research team decision'],
  ['trader_investment_plan', 'Trading plan'],
  ['final_trade_decision', 'Portfolio decision'],
];
const SETTING_FIELDS = [
  ['deep_think_provider', 'Deep model provider'],
  ['deep_think_llm', 'Deep model'],
  ['quick_think_provider', 'Quick model provider'],
  ['quick_think_llm', 'Quick model'],
  ['max_debate_rounds', 'Research debate rounds'],
  ['max_risk_discuss_rounds', 'Risk discussion rounds'],
  ['version', 'TradingAgents version'],
];

function assertPrefix(prefix) {
  if (!PREFIXES.has(prefix)) throw new TypeError('Untrusted application prefix');
}

export function routeFor(pathname, prefix) {
  assertPrefix(prefix);
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) throw new TypeError('Invalid route');
  const base = `${prefix}/research`;
  if (pathname === base || pathname === `${base}/`) return { kind: 'list' };
  if (prefix && pathname.startsWith(prefix) && pathname[prefix.length] !== '/') {
    throw new TypeError('Route does not match application prefix');
  }
  if (!pathname.startsWith(`${base}/`)) return { kind: 'list' };
  const id = pathname.slice(base.length + 1).replace(/\/$/, '');
  return UUID.test(id) ? { kind: 'detail', id: id.toLowerCase() } : { kind: 'list' };
}

// Loading-UI fix: a list-to-list navigation (filter/page change) should keep
// the ticker/date/status controls and pager mounted and only clear/reload the
// results region -- a route change into or out of the detail view still gets
// the full-page loading state, same as before.
export function isListRefresh(previousRoute, nextRoute) {
  return previousRoute?.kind === 'list' && nextRoute?.kind === 'list';
}

// Loading-UI fix (owner-switch correction, review finding): the cached list
// shell bakes a owner-specific operator-import-key panel in at build time.
// It must never survive an identity change -- a refresh response naming a
// different (or newly missing/invalid) owner always rebuilds the shell
// instead of reusing one still showing a previous owner's opaque key.
export function shouldRebuildListShell(existingOwnerId, nextOwnerId) {
  return existingOwnerId !== nextOwnerId;
}

export function apiPath(prefix, suffix) {
  assertPrefix(prefix);
  if (typeof suffix !== 'string' || !suffix.startsWith('/') || suffix.startsWith('//')) {
    throw new TypeError('Invalid API path');
  }
  const path = suffix.split(/[?#]/, 1)[0];
  if (path.split('/').some((part) => part === '..' || /%2e/i.test(part))) {
    throw new TypeError('Invalid API path');
  }
  return `${prefix}/api${suffix}`;
}

const STAGE_LABELS = {
  starting: 'Preparing researchers', analyst: 'Analyst research', research: 'Research debate',
  trading: 'Trading plan', risk: 'Risk review', exporting: 'Preparing downloads', finished: 'Finished',
};

function secondsSince(value, now) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? Math.max(0, Math.floor((now - time) / 1000)) : null;
}

export function researchProgress(record, now = Date.now()) {
  const running = record.status === 'running';
  const end = running ? now : Date.parse(record.ended_at);
  const elapsedSeconds = Number.isFinite(end) ? secondsSince(record.created_at, end) : null;
  const progressAgeSeconds = secondsSince(record.last_progress_at || record.created_at, now);
  const heartbeatAgeSeconds = secondsSince(record.heartbeat_at, now);
  let warning = '';
  if (running && (heartbeatAgeSeconds == null ? elapsedSeconds >= 20 : heartbeatAgeSeconds >= 20)) {
    warning = 'Worker heartbeat is delayed. Research status is unconfirmed; the worker may have stalled.';
  } else if (running && progressAgeSeconds >= 180) {
    warning = 'No new research activity for 3 minutes or more. A model or data request may be slow; this is not a confirmed failure.';
  }
  return {
    elapsedSeconds, progressAgeSeconds, heartbeatAgeSeconds, warning,
    tone: warning ? 'warning' : running ? 'running' : record.status,
    label: STAGE_LABELS[record.stage] || (running ? 'Starting research' : statusText(record.status)),
  };
}

export function retryableReadError(error) {
  const status = error.status || 0;
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

export function runFailureMessage(record) {
  if (record.status === 'interrupted') return 'Research was interrupted before completion. Saved analysis is preserved; Run again starts a new research.';
  return ({
    LAUNCH_FAILED: 'The research worker could not start. Please try a new run.',
    RESEARCH_FAILED: 'Research could not complete. Any saved analysis is shown below; you can start a new run.',
    EXPORT_FAILED: 'Research ended, but downloadable reports could not be prepared. Saved analysis is shown below.',
  })[record.error_code] || 'Research could not complete. Any saved analysis is preserved; please try a new run.';
}

function duration(seconds) {
  if (seconds == null) return 'Unavailable';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function text(tag, value, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  return element;
}

function element(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (name === 'text') node.textContent = value;
    else if (name === 'hidden') node.hidden = Boolean(value);
    else if (name in node && !name.startsWith('aria-') && !name.startsWith('data-')) node[name] = value;
    else node.setAttribute(name, String(value));
  }
  return node;
}

function link(href, label, route = false) {
  return element('a', '', { href, text: label, ...(route ? { 'data-route': '' } : {}) });
}

function display(value) {
  return typeof value === 'string' && value.trim() ? value : 'Unknown';
}

function readableDate(value) {
  if (typeof value !== 'string' || !value) return 'Unknown';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function statusText(status) {
  return ({ running: 'Running', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted' })[status] || 'Unknown';
}

function statusBadge(status) {
  const known = ['running', 'completed', 'failed', 'interrupted'].includes(status) ? status : 'unknown';
  return element('span', `badge badge-${known}`, { text: statusText(status) });
}

function fallbackMessage(response, payload) {
  if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message;
  if (response.status === 401) return 'Your session may have expired. Return to TradingAgents, sign in, then open research history again.';
  if (response.status === 404) return 'This research is unavailable or was not shared with your account.';
  if (response.status === 409) return 'This action is not available yet. A research run may already be active, or its report is not ready.';
  if (response.status === 422) return 'Check the research inputs and try again.';
  return 'Could not load research. Try again in a moment.';
}

if (typeof document !== 'undefined') {
  const app = document.querySelector('#app');
  const appStatus = document.querySelector('#app-status');
  const prefix = document.body.dataset.appPrefix;
  assertPrefix(prefix);
  const base = `${prefix}/research`;
  let route = routeFor(window.location.pathname, prefix);
  let activeController = null;
  let pollTimer = null;
  let generation = 0;
  let items = [];
  let pageLimit = PAGE_SIZE;
  let pageOffset = 0;
  // History filters (final-fix wave, spec §5): applied server-side via
  // Store.list_owned across the caller's whole history, not just the
  // current page -- mirrored into the URL the same way pageOffset already
  // is, so reload/Back/Forward restore them.
  let filterTicker = '';
  let filterStatus = '';
  let filterDate = '';
  let listToday = '';
  let ownerId = '';
  let listControls = null;
  let lastListStatus = '';
  let lastDetailSignature = '';
  let serverClockOffset = 0;

  function announce(message) {
    if (appStatus) appStatus.textContent = message;
  }

  function stopWork() {
    generation += 1;
    if (activeController) activeController.abort();
    activeController = null;
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = null;
    return generation;
  }

  function showError(message, status = 0) {
    listControls = null;
    app.classList.remove('connection-lost');
    app.replaceChildren();
    const section = element('section', 'empty-state error-state');
    section.append(text('h1', status === 404 ? 'Research not found' : status === 401 ? 'Sign in to continue' : 'Research unavailable'));
    section.append(text('p', message));
    const actions = element('div', 'actions');
    actions.append(link(base, 'Research history', true));
    actions.append(link(`${prefix}/`, 'Return to TradingAgents', true));
    section.append(actions);
    app.append(section);
  }

  async function request(path, options = {}, token = generation) {
    const controller = new AbortController();
    activeController = controller;
    let timedOut = false;
    const deadline = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10000);
    try {
      const response = await fetch(apiPath(prefix, path), {
        credentials: 'same-origin',
        ...options,
        signal: controller.signal,
      });
      let payload = null;
      try { payload = await response.json(); } catch { /* use static fallback below */ }
      if (!response.ok) {
        const error = new Error(fallbackMessage(response, payload));
        error.status = response.status;
        throw error;
      }
      if (controller.signal.aborted || token !== generation) return null;
      if (!payload || typeof payload !== 'object') {
        const error = new Error('The research service returned an unreadable response.');
        error.status = 502;
        throw error;
      }
      const serverTime = Date.parse(response.headers.get('date'));
      if (Number.isFinite(serverTime)) serverClockOffset = serverTime - Date.now();
      return payload;
    } catch (error) {
      if (timedOut) throw new Error(options.method
        ? 'Connection timed out. Check research history before repeating this action.'
        : 'Connection timed out. Retrying the research status.');
      throw error;
    } finally {
      window.clearTimeout(deadline);
      if (activeController === controller) activeController = null;
    }
  }

  function schedulePoll(shouldPoll, token) {
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = null;
    if (!shouldPoll || document.hidden || token !== generation) return;
    pollTimer = window.setTimeout(() => refresh(token), 3000);
  }

  function clearConnectionWarning() {
    app.classList.remove('connection-lost');
    app.querySelector('.connection-warning')?.remove();
  }

  function handleReadError(error, token) {
    if (error.name === 'AbortError' || token !== generation) return;
    if (!retryableReadError(error)) {
      // Authorization loss or revocation must clear the last private snapshot,
      // not be mistaken for a temporary network interruption.
      showError(error.message, error.status);
      return;
    }
    let warning = app.querySelector('.connection-warning');
    if (!warning) {
      warning = element('section', 'connection-warning', { role: 'status', 'aria-live': 'polite' });
      warning.append(text('strong', 'Connection lost · retrying'));
      warning.append(text('p', 'Showing the last known state. Current server status is unavailable; this does not mean research failed. No new research will be submitted.'));
      app.prepend(warning);
      announce('Connection lost. Retrying status; last known research is retained.');
    }
    app.classList.add('connection-lost');
    app.querySelectorAll('.is-running').forEach(node => node.classList.remove('is-running'));
    const progress = app.querySelector('.progress-panel');
    if (progress) {
      progress.dataset.tone = 'disconnected';
      progress.querySelector('progress').hidden = true;
    }
    schedulePoll(true, token);
  }

  function navigate(path, replace = false) {
    if (replace) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
    handleLocation();
  }

  function bindRouteLinks(root = app) {
    root.querySelectorAll('a[data-route]').forEach((anchor) => {
      anchor.addEventListener('click', (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const destination = new URL(anchor.href, window.location.href);
        if (destination.origin !== window.location.origin) return;
        event.preventDefault();
        navigate(`${destination.pathname}${destination.search}`);
      });
    });
  }

  function scheduleListOffset(offset) {
    const url = new URL(window.location.href);
    if (offset) url.searchParams.set('offset', String(offset));
    else url.searchParams.delete('offset');
    navigate(`${url.pathname}${url.search}`);
  }

  // Applying/changing any history filter resets to page one: the previous
  // offset belongs to a different (unfiltered or differently-filtered)
  // result set and otherwise could silently point past the end of this one.
  function scheduleListFilters({ ticker, status, analysisDate }) {
    const url = new URL(window.location.href);
    url.searchParams.delete('offset');
    for (const [param, value] of [['ticker', ticker], ['status', status], ['analysis_date', analysisDate]]) {
      if (value) url.searchParams.set(param, value);
      else url.searchParams.delete(param);
    }
    navigate(`${url.pathname}${url.search}`);
  }

  function createInput(labelText, name, type, value, attrs = {}) {
    const wrapper = element('label', 'field');
    wrapper.append(text('span', labelText));
    const input = element('input', '', { type, name, value, ...attrs });
    wrapper.append(input);
    return { wrapper, input };
  }

  function makeResearchForm(initial = {}, today = '') {
    const form = element('form', 'research-form');
    form.noValidate = true;
    const errorSummary = element('div', 'error-summary', { role: 'alert', tabindex: '-1', hidden: true });
    const errorTitle = text('h2', 'There is a problem');
    errorTitle.id = `error-title-${generation}`;
    errorSummary.setAttribute('aria-labelledby', errorTitle.id);
    errorSummary.append(errorTitle);
    const errorList = element('ul', '');
    errorSummary.append(errorList);
    form.append(errorSummary);

    const ticker = createInput('Ticker', 'ticker', 'text', typeof initial.ticker === 'string' ? initial.ticker : '', {
      required: true, maxlength: 32, autocomplete: 'off', autocapitalize: 'characters', spellcheck: false,
      'aria-describedby': `ticker-help-${generation}`,
    });
    ticker.input.id = `ticker-${generation}`;
    ticker.wrapper.append(text('small', 'Up to 32 characters.', 'field-help'));
    const tickerError = text('small', '', 'field-error');
    tickerError.id = `ticker-error-${generation}`;
    tickerError.hidden = true;
    ticker.wrapper.append(tickerError);
    form.append(ticker.wrapper);
    // Minor (final review): generation-scoped like every other id in this
    // form -- no collision today (only one makeResearchForm renders at a
    // time), but this is the one id here that wasn't, and the fix is
    // mechanical, not a new abstraction.
    const tickerHelp = form.querySelector('.field-help');
    tickerHelp.id = `ticker-help-${generation}`;
    ticker.input.setAttribute('aria-describedby', `ticker-help-${generation} ${tickerError.id}`);

    const date = createInput('Analysis date', 'analysis_date', 'date',
      typeof initial.analysis_date === 'string' ? initial.analysis_date : today);
    date.input.id = `analysis-date-${generation}`;
    date.input.required = true;
    const dateError = text('small', '', 'field-error');
    dateError.id = `date-error-${generation}`;
    dateError.hidden = true;
    date.wrapper.append(dateError);
    date.input.setAttribute('aria-describedby', dateError.id);
    form.append(date.wrapper);

    const asset = element('label', 'field');
    asset.append(text('span', 'Asset type'));
    const assetSelect = element('select', '', { name: 'asset_type', required: true, id: `asset-type-${generation}` });
    for (const [value, label] of [['', 'Choose an asset type'], ['stock', 'Stock'], ['crypto', 'Crypto']]) {
      const option = element('option', '', { value, text: label });
      option.selected = initial.asset_type === value;
      assetSelect.append(option);
    }
    asset.append(assetSelect);
    const assetError = text('small', '', 'field-error');
    assetError.id = `asset-error-${generation}`;
    assetError.hidden = true;
    asset.append(assetError);
    assetSelect.setAttribute('aria-describedby', assetError.id);
    form.append(asset);

    const depth = element('label', 'field');
    depth.append(text('span', 'Research depth'));
    const depthSelect = element('select', '', { name: 'research_depth', required: true, id: `depth-${generation}` });
    const placeholder = element('option', '', { value: '', text: 'Choose a depth' });
    placeholder.selected = ![1, 2, 3, 4, 5].includes(Number(initial.research_depth));
    depthSelect.append(placeholder);
    for (let value = 1; value <= 5; value += 1) {
      const option = element('option', '', { value: String(value), text: `Level ${value}` });
      option.selected = Number(initial.research_depth) === value;
      depthSelect.append(option);
    }
    depth.append(depthSelect);
    const depthError = text('small', '', 'field-error');
    depthError.id = `depth-error-${generation}`;
    depthError.hidden = true;
    depth.append(depthError);
    form.append(depth);
    depthSelect.setAttribute('aria-describedby', depthError.id);

    const analystGroup = element('fieldset', 'analyst-fieldset');
    analystGroup.id = `analysts-${generation}`;
    analystGroup.tabIndex = -1;
    analystGroup.append(text('legend', 'Analysts'));
    const analystError = text('small', 'Choose at least one analyst.', 'field-error');
    analystError.id = `analysts-error-${generation}`;
    analystError.hidden = true;
    analystGroup.setAttribute('aria-describedby', analystError.id);
    const selected = Array.isArray(initial.analysts) ? initial.analysts : [];
    const analysts = [
      ['market', 'Market'], ['social', 'Sentiment'], ['news', 'News'], ['fundamentals', 'Fundamentals'],
    ];
    for (const [value, labelText] of analysts) {
      const label = element('label', 'check-field');
      const checkbox = element('input', '', { type: 'checkbox', name: 'analysts', value });
      checkbox.checked = selected.includes(value);
      if (value === 'fundamentals') checkbox.setAttribute('aria-describedby', analystError.id);
      label.append(checkbox, text('span', labelText));
      analystGroup.append(label);
      if (value === 'fundamentals') {
        const fundamentalsNote = text('small', 'Fundamentals analysis is not available for crypto.', 'field-help');
        fundamentalsNote.id = `fundamentals-note-${generation}`;
        checkbox.setAttribute('aria-describedby', fundamentalsNote.id);
        analystGroup.append(fundamentalsNote);
      }
    }
    analystGroup.append(analystError);
    form.append(analystGroup);

    const message = text('p', '', 'form-message');
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');
    form.append(message);
    const actions = element('div', 'actions');
    const submit = element('button', 'button button-primary', { type: 'submit', text: 'Start research' });
    const cancel = element('button', 'button button-quiet', { type: 'button', text: 'Cancel' });
    actions.append(submit, cancel);
    form.append(actions);

    const fundamentals = analystGroup.querySelector('input[value="fundamentals"]');
    function updateAssetOptions() {
      const isCrypto = assetSelect.value === 'crypto';
      if (isCrypto) fundamentals.checked = false;
      fundamentals.disabled = isCrypto;
      fundamentals.setAttribute('aria-describedby', isCrypto ? `fundamentals-note-${generation}` : analystError.id);
      analystError.hidden = true;
    }
    assetSelect.addEventListener('change', updateAssetOptions);
    updateAssetOptions();
    ticker.input.addEventListener('input', () => { tickerError.hidden = true; ticker.input.removeAttribute('aria-invalid'); });
    date.input.addEventListener('change', () => { dateError.hidden = true; date.input.removeAttribute('aria-invalid'); });
    assetSelect.addEventListener('change', () => { assetError.hidden = true; assetSelect.removeAttribute('aria-invalid'); });
    depthSelect.addEventListener('change', () => { depthError.hidden = true; depthSelect.removeAttribute('aria-invalid'); });

    cancel.addEventListener('click', () => {
      const container = form.closest('.form-panel');
      if (container) {
        container.hidden = true;
        container.querySelector('[aria-controls]')?.setAttribute('aria-expanded', 'false');
      }
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorList.replaceChildren();
      errorSummary.hidden = true;
      message.textContent = '';
      const pickedAnalysts = [...form.querySelectorAll('input[name="analysts"]:checked')].map((input) => input.value);
      const problems = [];
      const fieldErrors = [
        [ticker.input, tickerError, 'Enter a ticker of at most 32 characters.', !ticker.input.value.trim() || !ticker.input.checkValidity()],
        [date.input, dateError, 'Choose an analysis date.', !date.input.value],
        [assetSelect, assetError, 'Choose an asset type.', !assetSelect.value],
        [depthSelect, depthError, 'Choose a research depth from 1 to 5.', !depthSelect.value],
      ];
      for (const [control, error, messageText, invalid] of fieldErrors) {
        error.textContent = invalid ? messageText : '';
        error.hidden = !invalid;
        control.setAttribute('aria-invalid', String(invalid));
        if (invalid) problems.push([messageText, control]);
      }
      if (!pickedAnalysts.length) {
        analystError.textContent = 'Choose at least one analyst.';
        analystError.hidden = false;
        analystGroup.setAttribute('aria-invalid', 'true');
        problems.push(['Choose at least one analyst.', analystGroup]);
      } else {
        analystError.hidden = true;
        analystGroup.removeAttribute('aria-invalid');
      }
      if (problems.length) {
        for (const [problem, target] of problems) {
          const item = element('li', '');
          const anchor = element('a', '', { href: `#${target.id}`, text: problem });
          anchor.addEventListener('click', (click) => { click.preventDefault(); target.focus(); });
          item.append(anchor);
          errorList.append(item);
        }
        errorSummary.hidden = false;
        errorSummary.focus();
        return;
      }
      const body = {
        ticker: ticker.input.value.trim(),
        analysis_date: date.input.value,
        asset_type: assetSelect.value,
        analysts: pickedAnalysts,
        research_depth: Number(depthSelect.value),
      };
      if (pollTimer) window.clearTimeout(pollTimer);
      pollTimer = null;
      const submitGeneration = generation;
      submit.disabled = true;
      message.textContent = 'Starting research…';
      try {
        const payload = await request('/research', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!payload || !UUID.test(payload.id)) throw new Error('Research was accepted but its identifier was invalid. Check history before retrying.');
        message.textContent = 'Research accepted. Opening run…';
        navigate(`${base}/${payload.id.toLowerCase()}`);
      } catch (error) {
        if (error.name === 'AbortError') {
          if (submitGeneration === generation) message.textContent = 'Request outcome unknown. Check history before retrying; no automatic retry was made.';
          return;
        }
        message.textContent = error.message || 'Could not start research. Check history before trying again.';
      } finally {
        submit.disabled = false;
        if (submitGeneration === generation) schedulePoll(items.some((item) => item.status === 'running'), generation);
      }
    });
    return form;
  }

  function makeListPage() {
    app.replaceChildren();
    const heading = element('div', 'page-heading');
    const title = element('div', '');
    title.append(text('h1', 'Research history'));
    title.append(text('p', 'Private by default. Shared reports require explicit owner approval.'));
    heading.append(title);
    const newButton = element('button', 'button button-primary', { type: 'button', text: 'New research', 'aria-expanded': 'false', 'aria-controls': 'new-research-panel' });
    heading.append(newButton);
    app.append(heading);

    const panel = element('section', 'form-panel', { id: 'new-research-panel', hidden: true });
    panel.append(text('h2', 'Start new research'));
    panel.append(makeResearchForm({}, listToday));
    app.append(panel);
    newButton.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      newButton.setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden) panel.querySelector('input[name="ticker"]').focus();
    });

    const controls = element('section', 'list-controls', { 'aria-label': 'Research filters' });
    const ticker = createInput('Ticker', 'ticker_filter', 'text', filterTicker, { autocomplete: 'off', maxlength: 32 });
    ticker.input.setAttribute('aria-label', 'Filter history by exact ticker');
    ticker.wrapper.append(text('small', 'Matches the exact ticker across your whole history.', 'field-help'));
    const analysisDate = createInput('Analysis date', 'analysis_date_filter', 'date', filterDate);
    analysisDate.input.setAttribute('aria-label', 'Filter history by analysis date');
    const statusLabel = element('label', 'field');
    statusLabel.append(text('span', 'Status'));
    const status = element('select', '', { 'aria-label': 'Filter by status' });
    for (const [value, labelText] of [['', 'All statuses'], ['running', 'Running'], ['completed', 'Completed'], ['failed', 'Failed'], ['interrupted', 'Interrupted']]) {
      const option = element('option', '', { value, text: labelText });
      option.selected = filterStatus === value;
      status.append(option);
    }
    statusLabel.append(status);
    controls.append(ticker.wrapper, analysisDate.wrapper, statusLabel);
    app.append(controls);
    const results = element('section', 'results', { 'aria-label': 'Research runs' });
    results.id = 'research-results';
    app.append(results);
    const pager = element('nav', 'pager', { 'aria-label': 'History pages' });
    const previous = element('button', 'button button-quiet', { type: 'button', text: 'Previous page' });
    const pageLabel = text('span', 'Page 1', 'page-label');
    const next = element('button', 'button button-quiet', { type: 'button', text: 'Next page' });
    pager.append(previous, pageLabel, next);
    app.append(pager);
    previous.addEventListener('click', () => scheduleListOffset(Math.max(0, pageOffset - pageLimit)));
    next.addEventListener('click', () => scheduleListOffset(pageOffset + pageLimit));
    // Filters apply across the caller's whole history via the API (spec
    // §5), not just this page -- `change` (blur/Enter/select), not `input`,
    // so a server round trip doesn't fire on every keystroke.
    const applyFilters = () => scheduleListFilters({
      ticker: ticker.input.value.trim(), status: status.value, analysisDate: analysisDate.input.value,
    });
    ticker.input.addEventListener('change', applyFilters);
    analysisDate.input.addEventListener('change', applyFilters);
    status.addEventListener('change', applyFilters);

    if (ownerId) {
      const importDetails = element('details', 'owner-key');
      importDetails.append(text('summary', 'Operator import key'));
      importDetails.append(text('p', 'Use only with the operator import process.'));
      importDetails.append(text('code', ownerId));
      app.append(importDetails);
    }
    return { results, previous, next, pageLabel, tickerInput: ticker.input, dateInput: analysisDate.input, statusSelect: status, ownerId };
  }

  function recordLabel(record) {
    return display(record?.inputs?.ticker);
  }

  function drawList(results, previous, next, pageLabel) {
    results.replaceChildren();
    // Filters are applied server-side, across the caller's whole history
    // (spec §5) -- `items` is already exactly this page's filtered result,
    // never re-filtered here.
    const filtersActive = Boolean(filterTicker || filterStatus || filterDate);
    if (!items.length) {
      const empty = element('div', 'empty-state');
      empty.append(text('h2', filtersActive ? 'No matching research' : 'No research yet'));
      empty.append(text('p', filtersActive ? 'Adjust filters to see other runs in your history.' : 'Start a run when you are ready. Each request creates a separate private record.'));
      results.append(empty);
    } else {
      const tableWrap = element('div', 'table-wrap');
      const table = element('table', 'research-table');
      const head = element('thead', '');
      const headerRow = element('tr', '');
      for (const label of ['Ticker', 'Analysis date', 'Status', 'Stage', 'Origin', 'Updated']) headerRow.append(text('th', label));
      head.append(headerRow);
      table.append(head);
      const body = element('tbody', '');
      const cards = element('ul', 'research-cards');
      for (const record of items) {
        const activity = researchProgress(record, Date.now() + serverClockOffset);
        const detailPath = `${base}/${encodeURIComponent(record.id)}`;
        const tickerLink = link(detailPath, recordLabel(record), true);
        const row = element('tr', '');
        const tickerCell = element('th', '', { scope: 'row' });
        tickerCell.append(tickerLink);
        row.append(tickerCell);
        row.append(text('td', readableDate(record.inputs?.analysis_date)));
        const stateCell = element('td', '');
        stateCell.append(statusBadge(record.status));
        if (record.status === 'running') {
          stateCell.querySelector('.badge-running').classList.toggle('is-running', activity.tone === 'running');
          stateCell.append(text('small', activity.warning || `Elapsed ${duration(activity.elapsedSeconds)} · heartbeat ${activity.heartbeatAgeSeconds == null ? 'pending' : `${activity.heartbeatAgeSeconds}s ago`}`, 'task-activity'));
        }
        if (record.shared) stateCell.append(text('span', 'Shared with family', 'badge badge-shared'));
        if (record.partial) stateCell.append(text('span', 'Partial', 'badge badge-partial'));
        row.append(stateCell, text('td', display(record.stage)), text('td', record.origin === 'web' ? 'Web' : record.origin === 'import' ? 'Imported' : 'Unknown'), text('td', readableDate(record.updated_at)));
        body.append(row);

        const card = element('li', 'research-card');
        if (record.status === 'running') card.classList.toggle('is-running', activity.tone === 'running');
        const cardHeading = element('div', 'card-heading');
        cardHeading.append(tickerLink.cloneNode(true), statusBadge(record.status));
        card.append(cardHeading);
        card.append(text('p', `Analysis date: ${readableDate(record.inputs?.analysis_date)}`));
        card.append(text('p', `Stage: ${display(record.stage)}`));
        if (record.status === 'running') card.append(text('p', activity.warning || `Elapsed ${duration(activity.elapsedSeconds)} · heartbeat ${activity.heartbeatAgeSeconds == null ? 'pending' : `${activity.heartbeatAgeSeconds}s ago`}`, 'task-activity'));
        const badges = element('div', 'badge-row');
        badges.append(text('span', record.origin === 'web' ? 'Web run' : record.origin === 'import' ? 'Imported' : 'Origin unknown', 'badge badge-neutral'));
        if (record.shared) badges.append(text('span', 'Shared with family', 'badge badge-shared'));
        if (record.partial) badges.append(text('span', 'Partial', 'badge badge-partial'));
        card.append(badges);
        cards.append(card);
      }
      table.append(body);
      tableWrap.append(table);
      results.append(tableWrap, cards);
    }
    if (previous && next && pageLabel) {
      previous.disabled = pageOffset <= 0;
      next.disabled = items.length < pageLimit;
      pageLabel.textContent = `Page ${Math.floor(pageOffset / pageLimit) + 1}`;
    }
  }

  function addDefinition(list, label, value) {
    const row = element('div', 'definition-row');
    row.append(text('dt', label), text('dd', value));
    list.append(row);
  }

  function addReportSection(root, heading, content) {
    if (typeof content !== 'string' || !content.trim()) return;
    const section = element('section', 'report-section');
    section.append(text('h3', heading));
    section.append(text('pre', content, 'report-text'));
    root.append(section);
  }

  function addNestedText(root, label, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, content] of Object.entries(value)) {
      if (typeof content === 'string' && content.trim()) addReportSection(root, `${label}: ${key.replaceAll('_', ' ')}`, content);
    }
  }

  function shareControls(record, runId) {
    const section = element('section', 'share-panel');
    section.append(text('h2', 'Family sharing'));
    if (!record.can_share) {
      section.append(text('p', 'Read-only access. Only the owner can enable or revoke sharing.', 'muted'));
      section.append(text('span', 'Read only', 'badge badge-neutral'));
      return section;
    }
    const shareState = text('p', record.shared ? 'Shared with authenticated family members.' : 'Private. Family members cannot view this research.', 'share-state');
    section.append(shareState);
    const toggle = element('button', 'button button-quiet', { type: 'button', text: record.shared ? 'Revoke family access' : 'Enable family sharing' });
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      shareState.textContent = record.shared ? 'Revoking access…' : 'Enabling access…';
      try {
        const updated = await request(`/research/${encodeURIComponent(runId)}/sharing`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: !record.shared }),
        });
        if (updated) {
          renderDetail(updated, generation);
          schedulePoll(updated.status === 'running', generation);
        }
      } catch (error) {
        shareState.textContent = error.name === 'AbortError'
          ? (record.shared ? 'Shared with authenticated family members.' : 'Private. Family members cannot view this research.')
          : error.message || 'Sharing could not be changed.';
        toggle.disabled = false;
        if (error.name !== 'AbortError') schedulePoll(record.status === 'running', generation);
      }
    });
    section.append(toggle);
    if (record.shared) {
      const copy = element('button', 'button button-secondary', { type: 'button', text: 'Copy family link' });
      const fallback = element('label', 'field copy-fallback', { hidden: true });
      fallback.append(text('span', 'Select and copy this family link'));
      const input = element('input', '', { type: 'text', readonly: true, value: new URL(`${base}/${encodeURIComponent(runId)}`, window.location.origin).toString() });
      fallback.append(input);
      const copyStatus = text('p', '', 'form-message');
      copyStatus.setAttribute('role', 'status');
      copyStatus.setAttribute('aria-live', 'polite');
      copy.addEventListener('click', async () => {
        try {
          if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable');
          await navigator.clipboard.writeText(input.value);
          copyStatus.textContent = 'Family link copied.';
        } catch {
          fallback.hidden = false;
          copyStatus.textContent = 'Clipboard unavailable. Select the link below and copy it manually.';
          input.focus();
          input.select();
        }
      });
      section.append(copy, fallback, copyStatus);
      section.append(text('p', 'Revoking access will not delete copies already downloaded.', 'muted'));
    }
    return section;
  }

  function updateProgressPanel(panel, record) {
    const activity = researchProgress(record, Date.now() + serverClockOffset);
    panel.dataset.tone = activity.tone;
    panel.classList.toggle('is-running', activity.tone === 'running');
    const label = `${statusText(record.status)} · ${activity.label}`;
    const labelNode = panel.querySelector('.progress-label');
    if (labelNode.textContent !== label) labelNode.textContent = label;
    const metrics = panel.querySelector('.progress-metrics');
    metrics.replaceChildren(
      text('span', `Elapsed: ${duration(activity.elapsedSeconds)}`),
      text('span', `Last research activity: ${record.last_progress_at ? `${duration(activity.progressAgeSeconds)} ago` : 'not recorded'}`),
      text('span', `Worker heartbeat: ${activity.heartbeatAgeSeconds == null ? 'not recorded yet' : `${activity.heartbeatAgeSeconds}s ago`}`),
    );
    const message = record.status === 'failed' || record.status === 'interrupted'
      ? runFailureMessage(record) : activity.warning || (record.status === 'running'
        ? 'Live status refreshes every 3 seconds. A heartbeat confirms the worker is alive, not that research is advancing.'
        : 'Research is complete. Saved analysis is available below.');
    const messageNode = panel.querySelector('.progress-message');
    if (messageNode.textContent !== message) messageNode.textContent = message;
    panel.querySelector('progress').hidden = activity.tone !== 'running';
  }

  function renderDetail(record, token) {
    if (token !== generation || !record) return;
    const signature = JSON.stringify([
      record.status, record.stage, record.shared, record.partial, record.artifacts_ready,
      record.artifacts_ready ? record.updated_at : '', record.error_code, record.state,
      record.inputs, record.rating, record.can_share, record.can_rerun,
    ]);
    if (signature === lastDetailSignature) {
      // Heartbeat/clock changes update only the progress region. Rebuilding
      // the entire page every three seconds destroys focus and restarts motion.
      const panel = app.querySelector('.progress-panel');
      if (panel) updateProgressPanel(panel, record);
      return;
    }
    lastDetailSignature = signature;
    announce(`${recordLabel(record)}: ${statusText(record.status)}. Stage: ${display(record.stage)}.`);
    app.replaceChildren();
    const back = link(base, '← Research history', true);
    back.className = 'back-link';
    app.append(back);
    const heading = element('div', 'page-heading detail-heading');
    const title = element('div', '');
    title.append(text('h1', recordLabel(record)));
    title.append(text('p', `Analysis of ${readableDate(record.inputs?.analysis_date)}`));
    heading.append(title);
    const actions = element('div', 'actions');
    if (record.can_rerun && record.can_share) {
      const rerun = element('button', 'button button-primary', { type: 'button', text: 'Run again' });
      rerun.addEventListener('click', () => {
        const existing = app.querySelector('.rerun-panel');
        if (existing) {
          existing.hidden = false;
          existing.querySelector('input[name="ticker"]').focus();
          return;
        }
        const panel = element('section', 'form-panel rerun-panel');
        panel.append(text('h2', 'Review inputs for a new run'));
        panel.append(text('p', 'This creates a new research record; it does not rerun or replace this one.', 'muted'));
        panel.append(makeResearchForm(record.inputs || {}, ''));
        app.insertBefore(panel, app.querySelector('.detail-grid'));
        panel.querySelector('input[name="ticker"]').focus();
      });
      actions.append(rerun);
    }
    heading.append(actions);
    app.append(heading);

    const badges = element('div', 'badge-row detail-badges');
    badges.append(statusBadge(record.status));
    if (record.origin === 'import') badges.append(text('span', 'Imported', 'badge badge-neutral'));
    if (record.origin === 'web') badges.append(text('span', 'Web run', 'badge badge-neutral'));
    if (record.shared) badges.append(text('span', 'Shared with family', 'badge badge-shared'));
    if (record.partial) badges.append(text('span', 'Partial report', 'badge badge-partial'));
    if (!record.can_share) badges.append(text('span', 'Read only', 'badge badge-neutral'));
    app.append(badges);

    const progress = element('section', 'progress-panel', { 'aria-label': 'Research progress' });
    progress.append(element('div', 'progress-label', { 'aria-live': 'polite' }));
    progress.append(element('div', 'progress-metrics'));
    progress.append(element('p', 'progress-message', { role: 'status', 'aria-live': 'polite' }));
    const bar = element('progress', 'progress-bar', { max: 1, 'aria-label': 'Research is running' });
    bar.removeAttribute('value');
    progress.append(bar);
    updateProgressPanel(progress, record);
    app.append(progress);

    const grid = element('div', 'detail-grid');
    grid.classList.add('detail-layout');
    const mainColumn = element('div', 'detail-main');
    const sidebar = element('aside', 'detail-aside');
    const settings = element('section', 'settings-panel');
    settings.append(text('h2', 'Research settings'));
    const definitions = element('dl', 'definitions');
    addDefinition(definitions, 'Ticker', display(record.inputs?.ticker));
    addDefinition(definitions, 'Analysis date', display(record.inputs?.analysis_date));
    addDefinition(definitions, 'Asset type', display(record.inputs?.asset_type));
    const analystNames = Array.isArray(record.inputs?.analysts) && record.inputs.analysts.length
      ? record.inputs.analysts.map((value) => value === 'social' ? 'Sentiment' : display(value)).join(', ')
      : 'Unknown';
    addDefinition(definitions, 'Analysts', analystNames);
    addDefinition(definitions, 'Research depth', record.inputs?.research_depth == null ? 'Unknown' : String(record.inputs.research_depth));
    addDefinition(definitions, 'Created', readableDate(record.created_at));
    if (record.settings && typeof record.settings === 'object') {
      for (const [key, label] of SETTING_FIELDS) {
        const value = record.settings[key];
        if ((typeof value === 'string' && value.trim()) || typeof value === 'number') {
          addDefinition(definitions, label, String(value));
        }
      }
    }
    settings.append(definitions);
    if (record.origin === 'import') settings.append(text('p', 'Imported metadata may be incomplete. Unknown values are shown as Unknown.', 'muted'));
    mainColumn.append(settings);

    const report = element('section', 'report-panel');
    const reportHeading = element('div', 'section-heading');
    reportHeading.append(text('h2', 'Report'));
    if (record.partial) reportHeading.append(text('span', 'Some report sections may be missing.', 'partial-note'));
    report.append(reportHeading);
    if (record.artifacts_ready) {
      const downloads = element('nav', 'download-links', { 'aria-label': 'Download research report' });
      for (const [format, label] of [['md', 'Markdown'], ['html', 'HTML'], ['zip', 'ZIP archive']]) {
        downloads.append(link(apiPath(prefix, `/research/${encodeURIComponent(record.id)}/download?format=${format}`), `Download ${label}`));
      }
      report.append(downloads);
      const frame = element('iframe', 'report-preview', {
        title: `${recordLabel(record)} report preview`,
        src: apiPath(prefix, `/research/${encodeURIComponent(record.id)}/report${record.updated_at ? `?v=${encodeURIComponent(record.updated_at)}` : ''}`),
        loading: 'lazy',
      });
      frame.setAttribute('sandbox', '');
      report.append(frame);
    } else {
      report.append(text('p', record.status === 'running' ? 'The report will appear when its files are ready.' : 'No downloadable report is available for this run.', 'muted'));
    }
    const state = record.state && typeof record.state === 'object' ? record.state : {};
    if (typeof state.imported_markdown === 'string' && state.imported_markdown) {
      report.append(text('p', 'Imported report · original provenance unknown.', 'import-note'));
      addReportSection(report, 'Imported report', state.imported_markdown);
    }
    for (const [key, label] of REPORT_FIELDS) addReportSection(report, label, state[key]);
    addNestedText(report, 'Research debate', state.investment_debate_state);
    addNestedText(report, 'Risk discussion', state.risk_debate_state);
    if (record.rating && typeof record.rating === 'string') reportHeading.append(text('span', record.rating, 'rating'));
    mainColumn.append(report);
    sidebar.append(shareControls(record, record.id));
    grid.append(mainColumn, sidebar);
    app.append(grid);
    bindRouteLinks();
  }

  function renderListRecords(data, token) {
    if (token !== generation) return;
    items = Array.isArray(data.items) ? data.items : [];
    pageLimit = Number.isInteger(data.limit) && data.limit > 0 ? Math.min(data.limit, MAX_PAGE_SIZE) : PAGE_SIZE;
    pageOffset = Number.isInteger(data.offset) && data.offset >= 0 ? data.offset : pageOffset;
    listToday = typeof data.today === 'string' ? data.today : '';
    ownerId = typeof data.owner_id === 'string' ? data.owner_id : '';
    if (shouldRebuildListShell(listControls?.ownerId, ownerId)) listControls = makeListPage();
    drawList(listControls.results, listControls.previous, listControls.next, listControls.pageLabel);
    const statusSignature = items.map((item) => `${item.id}:${item.status}:${item.stage}`).join('|');
    if (statusSignature !== lastListStatus) {
      announce(`Research history updated. ${items.length} run${items.length === 1 ? '' : 's'} on this page.`);
      lastListStatus = statusSignature;
    }
    schedulePoll(items.some((item) => item.status === 'running'), token);
    bindRouteLinks();
  }

  async function loadList(token) {
    const query = new URLSearchParams({ limit: String(pageLimit), offset: String(pageOffset) });
    if (filterTicker) query.set('ticker', filterTicker);
    if (filterStatus) query.set('status', filterStatus);
    if (filterDate) query.set('analysis_date', filterDate);
    try {
      const data = await request(`/research?${query}`, {}, token);
      if (data) {
        if (!Array.isArray(data.items) || !/^[0-9a-f]{64}$/.test(data.owner_id || '')) {
          const error = new Error('The research service returned an incomplete history response.');
          error.status = 502;
          throw error;
        }
        clearConnectionWarning();
        renderListRecords(data, token);
      }
    } catch (error) {
      handleReadError(error, token);
    }
  }

  async function loadDetail(id, token) {
    try {
      const record = await request(`/research/${encodeURIComponent(id)}`, {}, token);
      if (!record || token !== generation) return;
      if (record.id !== id || !['running', 'completed', 'failed', 'interrupted'].includes(record.status)) {
        const error = new Error('The research service returned an incomplete status response.');
        error.status = 502;
        throw error;
      }
      clearConnectionWarning();
      renderDetail(record, token);
      schedulePoll(record.status === 'running', token);
    } catch (error) {
      handleReadError(error, token);
    }
  }

  function refresh(token = generation) {
    if (token !== generation || document.hidden) return;
    if (route.kind === 'detail') return loadDetail(route.id, token);
    return loadList(token);
  }

  // Clears only the results region (not the controls/pager) so a list-to-list
  // reload never shows stale rows under the new filters while keeping the
  // controls visible and usable.
  function showListLoading(results) {
    results.replaceChildren(text('p', 'Loading research history…', 'loading-state'));
  }

  // Keeps the mounted ticker/date/status inputs in sync with the URL (e.g.
  // Back/Forward), without touching values that already match -- so a
  // control the user just changed (and that drove this navigation) keeps
  // focus and cursor position.
  function syncListFilterInputs(controls) {
    if (controls.tickerInput.value !== filterTicker) controls.tickerInput.value = filterTicker;
    if (controls.dateInput.value !== filterDate) controls.dateInput.value = filterDate;
    if (controls.statusSelect.value !== filterStatus) controls.statusSelect.value = filterStatus;
  }

  function handleLocation() {
    const token = stopWork();
    clearConnectionWarning();
    const previousRoute = route;
    route = routeFor(window.location.pathname, prefix);
    const params = new URLSearchParams(window.location.search);
    const offset = Number(params.get('offset'));
    pageOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    filterTicker = params.get('ticker') || '';
    filterStatus = params.get('status') || '';
    filterDate = params.get('analysis_date') || '';
    lastDetailSignature = '';
    if (route.kind === 'detail') {
      listControls = null;
      lastListStatus = '';
      app.replaceChildren(text('p', 'Loading research…', 'loading-state'));
      loadDetail(route.id, token);
    } else if (listControls && isListRefresh(previousRoute, route)) {
      syncListFilterInputs(listControls);
      showListLoading(listControls.results);
      loadList(token);
    } else {
      listControls = null;
      lastListStatus = '';
      app.replaceChildren(text('p', 'Loading research history…', 'loading-state'));
      loadList(token);
    }
    bindRouteLinks();
  }

  window.addEventListener('popstate', handleLocation);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (pollTimer) window.clearTimeout(pollTimer);
      pollTimer = null;
      if (activeController) activeController.abort();
    } else {
      refresh(generation);
    }
  });
  document.addEventListener('click', (event) => {
    const anchor = event.target.closest?.('a[data-route]');
    if (!anchor || !app.contains(anchor)) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const destination = new URL(anchor.href, window.location.href);
    if (destination.origin !== window.location.origin) return;
    event.preventDefault();
    navigate(`${destination.pathname}${destination.search}`);
  });

  // replaceState keeps direct root deployments on the same canonical research shell route.
  if (route.kind === 'list' && window.location.pathname !== `${base}` && window.location.pathname !== `${base}/`) {
    window.history.replaceState(null, '', base);
  }
  handleLocation();
}
