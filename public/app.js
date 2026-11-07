'use strict';
(() => {
  const root = document.getElementById('root');

  const STATUS = {
    connected: { label: 'Connected to PayPal Sandbox', short: 'Connected', cls: 'ok' },
    auth_failed: { label: 'Credentials rejected', short: 'Credentials rejected', cls: 'bad' },
    unreachable: { label: 'PayPal unreachable', short: 'PayPal unreachable', cls: 'warn' },
    unverified: { label: 'Not verified', short: 'Not verified', cls: 'idle' },
  };
  const HELP = {
    auth_failed: [
      'In the PayPal Developer Dashboard, open Apps & Credentials and make sure the toggle is set to Sandbox, not Live.',
      'Copy the Client ID and Secret again, without leading or trailing spaces.',
      'If you regenerated the Secret in PayPal, the old one stops working. Use the new one.',
    ],
    unreachable: [
      'Check that this computer can reach the internet (and any proxy or firewall allows api-m.sandbox.paypal.com).',
      'Wait a minute and check again. PayPal Sandbox is sometimes slow or briefly down.',
    ],
    unverified: [
      'Select Check connection to test these credentials against PayPal Sandbox.',
    ],
  };

  const state = {
    projects: [], selectedId: null, view: 'empty', detail: null, busy: false,
    orders: [], calls: [], orderDetail: null, orderError: null, orderErrorScope: 'create', orderProjectId: null, orderKey: null,
    orderForm: { amount: '10.00', currency: 'USD', description: '' },
    events: [], eventTotal: 0, eventTypes: [], deliveries: [], eventDetail: null, eventError: null, webhookError: null,
    eventFilters: { status: '', type: '', q: '' },
    runs: [], runDetail: null, runError: null, scenarioKey: null,
    overview: null, findings: [], runFilter: '', probeResult: null, probeError: null,
    scenarioForm: { kind: 'forward', count: '3', mode: 'sequential', delaySeconds: '10' },
    aiPrompt: 'Test whether my application processes the same completed payment webhook twice.',
    aiPlans: [], aiSelectedPlan: null, aiPlanEventId: '', aiPlanError: null,
    aiAnalysis: null, aiAnalysisRunId: '', aiAnalysisError: null, aiSuggestions: null,
  };
  let pollTimer = null;

  // ---- helpers ----------------------------------------------------------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
      });
    } catch {
      const err = new Error('Could not reach the Faultline server. Check that it is still running in your terminal.');
      err.network = true;
      throw err;
    }
    let data = null;
    if (res.status !== 204) {
      try { data = await res.json(); } catch { data = null; }
    }
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || `Request failed (HTTP ${res.status}).`);
      err.status = res.status;
      err.code = data && data.error && data.error.code;
      err.fields = (data && data.error && data.error.fields) || {};
      err.details = data && data.error && data.error.details;
      throw err;
    }
    return data;
  }

  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString() : 'Never');
  const badge = (status) => {
    const s = STATUS[status] || STATUS.unverified;
    return h('span', { class: `badge ${s.cls}` }, s.short);
  };

  function field({ id, label, type = 'text', hint, value = '', autocomplete = 'off', error }) {
    const input = h('input', { id, name: id, type, value, autocomplete, spellcheck: 'false', class: error ? 'invalid' : null, 'aria-describedby': `${id}-msg` });
    if (type === 'password') input.value = '';
    const wrap = h('label', { class: 'field', for: id },
      h('span', { class: 'label' }, label),
      input,
      h('span', { id: `${id}-msg` },
        error ? h('span', { class: 'error', role: 'alert' }, error) : null,
        hint ? h('span', { class: 'hint' }, hint) : null));
    return { wrap, input };
  }

  function setFieldErrors(form, fields) {
    for (const [name, message] of Object.entries(fields || {})) {
      const input = form.querySelector(`#${name}`);
      if (!input) continue;
      input.classList.add('invalid');
      const msg = form.querySelector(`#${name}-msg`);
      if (msg) msg.prepend(h('span', { class: 'error', role: 'alert' }, message));
    }
  }

  // ---- screens ----------------------------------------------------------
  function topbar(signedIn) {
    return h('header', { class: 'topbar' },
      h('span', { class: 'wordmark' }, 'Faultline'),
      h('span', { class: 'env-tag' }, 'PayPal Sandbox'),
      h('span', { class: 'spacer' }),
      signedIn ? h('button', { class: 'btn', type: 'button', onclick: signOut }, 'Sign out') : null);
  }

  function showLogin(message) {
    const err = h('p', { class: 'error', role: 'alert' }, message || '');
    const { wrap, input } = field({ id: 'password', label: 'Password', type: 'password', autocomplete: 'current-password', hint: 'This is the ADMIN_PASSWORD from your .env file.' });
    const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      err.textContent = '';
      try {
        await api('POST', '/api/auth/login', { password: input.value });
        input.value = '';
        await showApp();
      } catch (ex) {
        err.textContent = ex.message;
        submit.disabled = false;
      }
    } }, wrap, err, submit);
    root.replaceChildren(topbar(false), h('main', { class: 'center' },
      h('h1', null, 'Sign in to Faultline'),
      h('p', { class: 'tagline' }, 'Don\u2019t just test whether your payment works. Test whether it survives failure.'),
      form));
    input.focus();
  }

  async function signOut() {
    try { await api('POST', '/api/auth/logout'); } catch { /* cookie is cleared server-side when reachable */ }
    state.projects = []; state.detail = null; state.selectedId = null;
    showLogin();
  }

  async function showApp() {
    root.replaceChildren(topbar(true), h('div', { class: 'layout' }, h('nav', { class: 'rail', id: 'rail', 'aria-label': 'Projects' }), h('main', { class: 'main', id: 'main' })));
    if (!(await loadProjects())) return;
    if (state.projects.length === 0) { state.view = 'new'; } else if (!state.selectedId) { await selectProject(state.projects[0].id); return; }
    renderMain();
  }

  async function loadProjects() {
    try {
      state.projects = (await api('GET', '/api/projects')).projects;
    } catch (ex) {
      if (ex.status === 401) { showLogin('Your session ended. Sign in again.'); return false; }
      state.projects = [];
      renderMain(ex.message);
    }
    renderRail();
    return true;
  }

  function renderRail() {
    const rail = document.getElementById('rail');
    if (!rail) return;
    const list = state.projects.length === 0
      ? h('p', { class: 'rail-empty' }, 'No projects yet.')
      : state.projects.map((p) => {
        const s = STATUS[p.connection.status] || STATUS.unverified;
        return h('button', { class: 'project-item', type: 'button', 'aria-current': String(p.id === state.selectedId && state.view !== 'new'), onclick: () => selectProject(p.id) },
          h('span', { class: `dot ${s.cls}`, 'aria-hidden': 'true' }),
          h('span', null, h('span', { class: 'name' }, p.name), h('span', { class: 'sub' }, s.short)));
      });
    rail.replaceChildren(
      h('div', { class: 'rail-head' }, h('h2', null, 'Projects'), h('button', { class: 'btn', type: 'button', onclick: () => { state.view = 'new'; renderRail(); renderMain(); } }, 'New project')),
      ...[].concat(list));
  }

  async function selectProject(id) {
    state.selectedId = id;
    state.view = 'detail';
    try {
      state.detail = await api('GET', `/api/projects/${id}`);
      if (state.orderProjectId !== id) {
        state.orderDetail = null; state.orderError = null; state.orderKey = newKey();
        state.eventDetail = null; state.eventError = null; state.webhookError = null; state.eventFilters = { status: '', type: '', q: '' };
        state.runDetail = null; state.runError = null; state.scenarioKey = newKey();
        state.aiPlans = []; state.aiSelectedPlan = null; state.aiPlanEventId = ''; state.aiPlanError = null;
        state.aiAnalysis = null; state.aiAnalysisRunId = ''; state.aiAnalysisError = null; state.aiSuggestions = null;
      }
      state.orderProjectId = id;
      await loadOrderData(id);
      await loadEventData(id);
      await loadRunData(id);
    } catch (ex) {
      if (ex.status === 401) return showLogin('Your session ended. Sign in again.');
      await loadProjects();
      state.selectedId = null; state.view = state.projects.length ? 'empty' : 'new';
      return renderMain(ex.message);
    }
    renderRail();
    renderMain();
  }

  function renderMain(errorText) {
    const main = document.getElementById('main');
    if (!main) return;
    const nodes = [];
    if (errorText) nodes.push(h('div', { class: 'alert bad', role: 'alert' }, errorText));
    if (state.view === 'new') nodes.push(newProjectForm());
    else if (state.view === 'edit' && state.detail) nodes.push(editProjectForm());
    else if (state.view === 'detail' && state.detail) nodes.push(...projectDetail());
    else nodes.push(h('p', { class: 'empty' }, 'Select a project, or create one.'));
    main.replaceChildren(...nodes.filter(Boolean));
    schedulePoll();
  }

  function credentialGuide() {
    return h('ol', { class: 'guide' },
      h('li', null, 'Sign in at developer.paypal.com and open Apps & Credentials.'),
      h('li', null, 'Switch the toggle to Sandbox.'),
      h('li', null, 'Create an app (or open the default one) and copy its Client ID and Secret.'));
  }

  function newProjectForm() {
    const f = {
      name: field({ id: 'name', label: 'Project name', hint: 'For example, Checkout service (staging).' }),
      clientId: field({ id: 'clientId', label: 'Sandbox Client ID' }),
      clientSecret: field({ id: 'clientSecret', label: 'Sandbox Secret', type: 'password', autocomplete: 'new-password', hint: 'Sent once over this connection, stored encrypted, and never shown again.' }),
      url: field({ id: 'webhookEndpointUrl', label: 'Your webhook endpoint URL', hint: 'The URL in your own application that receives PayPal webhooks, such as http://localhost:4000/webhooks/paypal.' }),
    };
    const err = h('div', { role: 'alert' });
    const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Create and check connection');
    const form = h('form', { novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      form.querySelectorAll('.error').forEach((n) => n.remove());
      form.querySelectorAll('.invalid').forEach((n) => n.classList.remove('invalid'));
      err.replaceChildren();
      submit.disabled = true; submit.textContent = 'Checking with PayPal\u2026';
      try {
        const data = await api('POST', '/api/projects', {
          name: f.name.input.value, clientId: f.clientId.input.value,
          clientSecret: f.clientSecret.input.value, webhookEndpointUrl: f.url.input.value,
        });
        f.clientSecret.input.value = '';
        await loadProjects();
        await selectProject(data.project.id);
      } catch (ex) {
        if (ex.status === 401) return showLogin('Your session ended. Sign in again.');
        setFieldErrors(form, ex.fields);
        if (!Object.keys(ex.fields || {}).length) err.replaceChildren(h('div', { class: 'alert bad' }, ex.message));
        submit.disabled = false; submit.textContent = 'Create and check connection';
      }
    } },
      credentialGuide(), f.name.wrap, f.clientId.wrap, f.clientSecret.wrap, f.url.wrap, err,
      h('div', { class: 'form-actions' }, submit,
        state.projects.length ? h('button', { class: 'btn', type: 'button', onclick: () => selectProject(state.selectedId || state.projects[0].id) }, 'Cancel') : null));
    return h('section', { class: 'panel' }, h('h1', { class: 'section' }, 'New project'), form);
  }

  function editProjectForm() {
    const p = state.detail.project;
    const f = {
      name: field({ id: 'name', label: 'Project name', value: p.name }),
      url: field({ id: 'webhookEndpointUrl', label: 'Your webhook endpoint URL', value: p.webhookEndpointUrl }),
      clientId: field({ id: 'clientId', label: 'New Sandbox Client ID', hint: 'Leave both credential fields empty to keep the current ones.' }),
      clientSecret: field({ id: 'clientSecret', label: 'New Sandbox Secret', type: 'password', autocomplete: 'new-password' }),
    };
    const err = h('div', { role: 'alert' });
    const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Save changes');
    const form = h('form', { novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      form.querySelectorAll('.error').forEach((n) => n.remove());
      form.querySelectorAll('.invalid').forEach((n) => n.classList.remove('invalid'));
      err.replaceChildren();
      const body = { name: f.name.input.value, webhookEndpointUrl: f.url.input.value };
      if (f.clientId.input.value || f.clientSecret.input.value) { body.clientId = f.clientId.input.value; body.clientSecret = f.clientSecret.input.value; }
      submit.disabled = true; submit.textContent = body.clientId ? 'Checking with PayPal\u2026' : 'Saving\u2026';
      try {
        const data = await api('PATCH', `/api/projects/${p.id}`, body);
        f.clientSecret.input.value = '';
        state.detail = { project: data.project, checks: data.checks };
        state.view = 'detail';
        await loadProjects();
        renderMain();
      } catch (ex) {
        if (ex.status === 401) return showLogin('Your session ended. Sign in again.');
        setFieldErrors(form, ex.fields);
        if (!Object.keys(ex.fields || {}).length) err.replaceChildren(h('div', { class: 'alert bad' }, ex.message));
        submit.disabled = false; submit.textContent = 'Save changes';
      }
    } }, f.name.wrap, f.url.wrap, f.clientId.wrap, f.clientSecret.wrap, err,
    h('div', { class: 'form-actions' }, submit, h('button', { class: 'btn', type: 'button', onclick: () => { state.view = 'detail'; renderMain(); } }, 'Cancel')));
    return h('section', { class: 'panel' }, h('h1', { class: 'section' }, `Edit ${p.name}`), form);
  }

  function projectDetail() {
    const { project: p, checks } = state.detail;
    const c = p.connection;
    const s = STATUS[c.status] || STATUS.unverified;

    const checkBtn = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      checkBtn.disabled = true; checkBtn.textContent = 'Checking with PayPal\u2026';
      try {
        const data = await api('POST', `/api/projects/${p.id}/validate`);
        state.detail = { project: data.project, checks: data.checks };
        await loadProjects();
        renderMain();
      } catch (ex) {
        if (ex.status === 401) return showLogin('Your session ended. Sign in again.');
        renderMain(ex.message);
      }
    } }, 'Check connection');

    const header = h('div', { class: 'title-row' },
      h('h1', null, p.name), badge(c.status),
      h('div', { class: 'actions' }, checkBtn,
        h('button', { class: 'btn', type: 'button', onclick: () => { state.view = 'edit'; renderMain(); } }, 'Edit'),
        h('button', { class: 'btn danger', type: 'button', onclick: async () => {
          if (!window.confirm(`Delete "${p.name}" and its check history? This cannot be undone.`)) return;
          try {
            await api('DELETE', `/api/projects/${p.id}`);
            state.selectedId = null; state.detail = null; state.view = 'empty';
            await loadProjects();
            if (state.projects.length) await selectProject(state.projects[0].id); else { state.view = 'new'; renderRail(); renderMain(); }
          } catch (ex) { renderMain(ex.message); }
        } }, 'Delete')));

    const alert = c.status === 'connected' ? null : h('div', { class: `alert ${s.cls === 'bad' ? 'bad' : s.cls === 'warn' ? 'warn' : 'idle'}`, role: 'status' },
      h('strong', null, c.status === 'unverified' && !c.errorMessage ? 'This connection has not been verified.' : `${s.label}.`),
      c.errorMessage ? h('p', { class: 'alert-text' }, c.errorMessage) : null,
      c.errorCode ? h('p', { class: 'code' }, `Error code: ${c.errorCode}`) : null,
      c.errorCode === 'secret_unreadable' ? h('ul', null, h('li', null, 'Select Edit and enter the Client ID and Secret again.')) : h('ul', null, (HELP[c.status] || []).map((t) => h('li', null, t))));

    const facts = h('section', { class: 'panel' },
      h('h2', { class: 'section' }, 'Configuration'),
      h('dl', { class: 'facts' },
        h('dt', null, 'Environment'), h('dd', null, 'PayPal Sandbox'),
        h('dt', null, 'Client ID'), h('dd', { class: 'mono' }, p.clientId),
        h('dt', null, 'Secret'), h('dd', null, 'Stored encrypted. Not shown.'),
        h('dt', null, 'Webhook destination'), h('dd', { class: 'mono' }, p.webhookEndpointUrl),
        h('dt', null, 'PayPal app ID'), h('dd', { class: 'mono' }, c.paypalAppId || 'Not available until a check succeeds'),
        h('dt', null, 'Last checked'), h('dd', null, fmtTime(c.checkedAt)),
        h('dt', null, 'Created'), h('dd', null, fmtTime(p.createdAt))));

    const rows = checks.map((k) => h('tr', null,
      h('td', null, fmtTime(k.checkedAt)),
      h('td', null, badge(k.outcome === 'connected' ? 'connected' : k.outcome === 'auth_failed' ? 'auth_failed' : k.outcome === 'unreachable' ? 'unreachable' : 'unverified')),
      h('td', { class: 'mono' }, k.httpStatus ?? '\u2014'),
      h('td', null, `${k.durationMs} ms`),
      h('td', { class: 'mono' }, k.errorCode || '\u2014'),
      h('td', { class: 'mono' }, k.paypalDebugId || '\u2014')));
    const history = h('section', { class: 'panel' },
      h('h2', { class: 'section' }, 'Connection checks'),
      checks.length === 0
        ? h('p', { class: 'empty' }, 'No checks yet. Select Check connection.')
        : h('div', { class: 'table-wrap' }, h('table', { class: 'checks' },
          h('thead', null, h('tr', null, ['Time', 'Result', 'HTTP', 'Duration', 'Error code', 'PayPal debug ID'].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, rows))));

    return [header, alert, overviewPanel(), facts, ...ordersSection(p), webhookPanel(p), probePanel(p), ...eventsSection(p), history];
  }


  // ---- sandbox orders -----------------------------------------------------
  const newKey = () => (window.crypto.randomUUID
    ? window.crypto.randomUUID()
    : Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));

  async function loadOrderData(projectId) {
    const [o, c] = await Promise.all([
      api('GET', `/api/projects/${projectId}/orders`),
      api('GET', `/api/projects/${projectId}/paypal-calls`),
    ]);
    state.orders = o.orders;
    state.calls = c.calls;
  }

  const ORDER_CLS = { COMPLETED: 'ok', APPROVED: 'warn', VOIDED: 'bad' };
  const CAPTURE_CLS = { COMPLETED: 'ok', PENDING: 'warn', DECLINED: 'bad', FAILED: 'bad' };
  const pretty = (v) => String(v || 'UNKNOWN').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const statusBadge = (value, map) => h('span', { class: `badge ${map[value] || 'idle'}` }, pretty(value));
  const money = (a) => (a ? `${a.value} ${a.currencyCode}` : '\u2014');

  function errorBox(ex) {
    const d = ex.details;
    const fieldMsgs = ex.fields ? Object.values(ex.fields) : [];
    return h('div', { class: 'alert bad', role: 'alert' },
      h('strong', null, ex.message),
      d ? h('p', { class: 'code' }, `PayPal HTTP ${d.httpStatus ?? 'n/a'} \u00B7 ${d.name || 'no error name'}${d.debugId ? ` \u00B7 debug ID ${d.debugId}` : ''}`) : null,
      d && d.issues && d.issues.length ? h('ul', null, d.issues.map((i) => h('li', null, `${i.issue || 'issue'}${i.description ? `: ${i.description}` : ''}`))) : null,
      fieldMsgs.length ? h('ul', null, fieldMsgs.map((m) => h('li', null, m))) : null);
  }

  // Runs one order action, then reloads the lists. Errors are shown, never hidden.
  async function orderAction(p, btn, busyText, fn, scope = 'detail') {
    btn.disabled = true;
    btn.textContent = busyText;
    state.orderError = null;
    state.orderErrorScope = scope;
    try {
      await fn();
    } catch (ex) {
      if (ex.status === 401) return showLogin('Your session ended. Sign in again.');
      state.orderError = ex;
    }
    try { await loadOrderData(p.id); } catch { /* keep the lists we already have */ }
    renderMain();
  }

  async function openOrder(p, orderId) {
    state.orderError = null;
    state.orderErrorScope = 'create';
    try { state.orderDetail = await api('GET', `/api/projects/${p.id}/orders/${orderId}`); } catch (ex) { state.orderError = ex; }
    renderMain();
  }

  function ordersSection(p) {
    const f = state.orderForm;
    const amount = h('input', { id: 'orderAmount', type: 'text', inputmode: 'decimal', value: f.amount, autocomplete: 'off', oninput: (e) => { f.amount = e.target.value; } });
    const currency = h('select', { id: 'orderCurrency', onchange: (e) => { f.currency = e.target.value; } },
      ['USD', 'EUR', 'GBP', 'CAD', 'AUD'].map((c) => h('option', { value: c, selected: c === f.currency }, c)));
    const desc = h('input', { id: 'orderDescription', type: 'text', maxlength: '127', value: f.description, autocomplete: 'off', oninput: (e) => { f.description = e.target.value; } });
    const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Create Sandbox order');
    const form = h('form', { class: 'row-form', novalidate: true, onsubmit: (e) => {
      e.preventDefault();
      orderAction(p, submit, 'Creating at PayPal\u2026', async () => {
        const data = await api('POST', `/api/projects/${p.id}/orders`, { amount: f.amount, currency: f.currency, description: f.description, idempotencyKey: state.orderKey });
        state.orderKey = newKey();
        state.orderDetail = await api('GET', `/api/projects/${p.id}/orders/${data.order.id}`);
      }, 'create');
    } },
    h('label', { class: 'field', for: 'orderAmount' }, h('span', { class: 'label' }, 'Amount'), amount),
    h('label', { class: 'field', for: 'orderCurrency' }, h('span', { class: 'label' }, 'Currency'), currency),
    h('label', { class: 'field grow', for: 'orderDescription' }, h('span', { class: 'label' }, 'Description (optional)'), desc),
    h('div', { class: 'field' }, h('span', { class: 'label' }, '\u00A0'), submit));

    const orderRows = state.orders.map((o) => h('tr', { class: state.orderDetail && state.orderDetail.order.id === o.id ? 'selected' : null },
      h('td', null, fmtTime(o.createdAt)),
      h('td', { class: 'mono' }, o.paypalOrderId),
      h('td', null, money(o.amount)),
      h('td', null, statusBadge(o.status, ORDER_CLS)),
      h('td', null, h('button', { class: 'btn', type: 'button', onclick: () => openOrder(p, o.id) }, 'Open'))));

    const ordersPanel = h('section', { class: 'panel' },
      h('h2', { class: 'section' }, 'Sandbox orders'),
      h('p', { class: 'hint-text' }, 'These are real orders in your PayPal Sandbox account. No real money moves. Faultline only shows what PayPal reports.'),
      form,
      state.orderError && state.orderErrorScope === 'create' ? errorBox(state.orderError) : null,
      state.orders.length === 0
        ? h('p', { class: 'empty' }, 'No orders yet. Create one above.')
        : h('div', { class: 'table-wrap' }, h('table', { class: 'checks' },
          h('thead', null, h('tr', null, ['Created', 'PayPal order ID', 'Amount', 'PayPal status', ''].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, orderRows))));

    const parts = [ordersPanel];
    if (state.orderDetail) parts.push(orderDetailPanel(p));
    parts.push(callsPanel());
    return parts;
  }

  function orderDetailPanel(p) {
    const { order, captures, raw } = state.orderDetail;
    const canApprove = order.approveUrl && !['APPROVED', 'COMPLETED', 'VOIDED'].includes(order.status);
    const refresh = h('button', { class: 'btn', type: 'button', onclick: () => orderAction(p, refresh, 'Asking PayPal\u2026', async () => {
      state.orderDetail = await api('POST', `/api/projects/${p.id}/orders/${order.id}/refresh`);
    }) }, 'Refresh from PayPal');
    const capture = h('button', { class: 'btn primary', type: 'button', disabled: order.status !== 'APPROVED', title: order.status === 'APPROVED' ? '' : 'PayPal only allows capture after the buyer approves.',
      onclick: () => orderAction(p, capture, 'Capturing\u2026', async () => {
        state.orderDetail = await api('POST', `/api/projects/${p.id}/orders/${order.id}/capture`);
      }) }, 'Capture payment');

    const guide = order.status === 'COMPLETED' ? null : h('ol', { class: 'guide' },
      h('li', null, canApprove
        ? 'Select Approve in PayPal Sandbox and sign in with a Sandbox personal (buyer) account. Find or create one at developer.paypal.com under Testing tools, then Sandbox accounts.'
        : 'The buyer approval step is done or not available for this order.'),
      h('li', null, 'Approve the payment. PayPal then sends the buyer to a Faultline page. Return to this tab.'),
      h('li', null, 'Select Refresh from PayPal. When PayPal reports Approved, select Capture payment.'));

    const capRows = captures.map((c) => h('tr', null,
      h('td', { class: 'mono' }, c.paypalCaptureId),
      h('td', null, statusBadge(c.status, CAPTURE_CLS)),
      h('td', null, money(c.amount)),
      h('td', null, c.finalCapture === null ? '\u2014' : c.finalCapture ? 'Yes' : 'No'),
      h('td', null, fmtTime(c.lastSyncedAt)),
      h('td', null, (() => {
        const b = h('button', { class: 'btn', type: 'button', onclick: () => orderAction(p, b, 'Asking PayPal\u2026', async () => {
          state.orderDetail = await api('POST', `/api/projects/${p.id}/orders/${order.id}/captures/${c.id}/refresh`);
        }) }, 'Refresh details');
        return b;
      })())));

    return h('section', { class: 'panel' },
      h('div', { class: 'title-row' },
        h('h2', { class: 'section nomargin' }, 'Order '), h('span', { class: 'mono' }, order.paypalOrderId), statusBadge(order.status, ORDER_CLS),
        h('div', { class: 'actions' },
          canApprove ? h('a', { class: 'btn primary', href: order.approveUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Approve in PayPal Sandbox') : null,
          refresh, capture)),
      state.orderError && state.orderErrorScope === 'detail' ? errorBox(state.orderError) : null,
      guide,
      h('dl', { class: 'facts' },
        h('dt', null, 'Amount'), h('dd', null, money(order.amount)),
        h('dt', null, 'Intent'), h('dd', null, order.intent),
        h('dt', null, 'Description'), h('dd', null, order.description || '\u2014'),
        h('dt', null, 'Faultline tag'), h('dd', { class: 'mono' }, `${order.customId} (sent to PayPal as custom_id)`),
        h('dt', null, 'Last synced with PayPal'), h('dd', null, fmtTime(order.lastSyncedAt))),
      h('h2', { class: 'section spaced' }, 'Captures'),
      captures.length === 0
        ? h('p', { class: 'empty' }, 'No capture yet. A capture exists only after PayPal confirms one.')
        : h('div', { class: 'table-wrap' }, h('table', { class: 'checks' },
          h('thead', null, h('tr', null, ['PayPal capture ID', 'Status', 'Amount', 'Final capture', 'Last synced', ''].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, capRows))),
      h('details', { class: 'raw-wrap' }, h('summary', null, 'Raw PayPal order response'), h('pre', { class: 'raw' }, JSON.stringify(raw, null, 2))));
  }

  function callsPanel() {
    const rows = state.calls.map((c) => h('tr', null,
      h('td', null, fmtTime(c.calledAt)),
      h('td', { class: 'mono' }, c.operation),
      h('td', { class: 'mono' }, c.paypalOrderId || '\u2014'),
      h('td', { class: 'mono' }, c.httpStatus ?? '\u2014'),
      h('td', null, h('span', { class: `badge ${c.outcome === 'ok' ? 'ok' : c.outcome === 'unreachable' ? 'warn' : 'bad'}` }, c.outcome === 'ok' ? 'OK' : c.outcome === 'unreachable' ? 'Unreachable' : 'PayPal error')),
      h('td', null, `${c.durationMs} ms`),
      h('td', { class: 'mono' }, c.errorName || '\u2014'),
      h('td', { class: 'mono' }, c.paypalDebugId || '\u2014')));
    return h('section', { class: 'panel' },
      h('h2', { class: 'section' }, 'Recent PayPal API calls'),
      state.calls.length === 0
        ? h('p', { class: 'empty' }, 'No calls yet.')
        : h('div', { class: 'table-wrap' }, h('table', { class: 'checks' },
          h('thead', null, h('tr', null, ['Time', 'Operation', 'Order', 'HTTP', 'Result', 'Duration', 'Error', 'PayPal debug ID'].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, rows))));
  }


  // ---- webhooks and event explorer ---------------------------------------
  const VERIFY = {
    verified: { label: 'Verified by PayPal', cls: 'ok' },
    failed: { label: 'Verification failed', cls: 'bad' },
    error: { label: 'Could not verify', cls: 'warn' },
    unverified: { label: 'Not verified', cls: 'idle' },
  };
  const verifyBadge = (status) => {
    const v = VERIFY[status] || VERIFY.unverified;
    return h('span', { class: `badge ${v.cls}` }, v.label);
  };

  async function loadEventData(projectId) {
    const f = state.eventFilters;
    const qs = new URLSearchParams({ limit: '50' });
    if (f.status) qs.set('status', f.status);
    if (f.type) qs.set('type', f.type);
    if (f.q.trim()) qs.set('q', f.q.trim());
    const [e, d, c, r, o, fnd, plans, sug] = await Promise.all([
      api('GET', `/api/projects/${projectId}/events?${qs}`),
      api('GET', `/api/projects/${projectId}/webhook-deliveries`),
      api('GET', `/api/projects/${projectId}/paypal-calls`),
      api('GET', `/api/projects/${projectId}/scenario-runs`),
      api('GET', `/api/projects/${projectId}/overview`),
      api('GET', `/api/projects/${projectId}/findings`),
      api('GET', `/api/projects/${projectId}/ai/plans`),
      api('GET', `/api/projects/${projectId}/ai/suggestions`),
    ]);
    state.overview = o; state.findings = fnd.findings;
    state.events = e.events; state.eventTotal = e.total; state.eventTypes = e.eventTypes; state.deliveries = d.deliveries; state.calls = c.calls; state.runs = r.runs;
    state.aiPlans = plans.plans; state.aiSuggestions = sug;
    if (state.aiSelectedPlan) state.aiSelectedPlan = state.aiPlans.find((x) => x.id === state.aiSelectedPlan.id) || state.aiPlans[0] || null;
    else if (state.aiPlans.length) state.aiSelectedPlan = state.aiPlans[0];
  }

  async function eventAction(p, btn, busyText, fn) {
    if (btn) { btn.disabled = true; btn.textContent = busyText; }
    state.eventError = null;
    try {
      await fn();
    } catch (ex) {
      if (ex.status === 401) return showLogin('Your session ended. Sign in again.');
      state.eventError = ex;
    }
    try { await loadEventData(p.id); } catch { /* keep the lists we already have */ }
    renderMain();
  }

  function webhookPanel(p) {
    const w = p.webhook;
    const idInput = h('input', { id: 'paypalWebhookId', type: 'text', value: w.paypalWebhookId || '', autocomplete: 'off', spellcheck: 'false' });
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save Webhook ID');
    const copy = h('button', { class: 'btn', type: 'button', onclick: async () => {
      try { await navigator.clipboard.writeText(w.receiverUrl); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy it by hand'; }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    } }, 'Copy');
    const form = h('form', { class: 'row-form', novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      save.disabled = true; save.textContent = 'Saving\u2026';
      state.webhookError = null;
      try {
        const data = await api('PATCH', `/api/projects/${p.id}`, { paypalWebhookId: idInput.value });
        state.detail = { project: data.project, checks: data.checks };
      } catch (ex) {
        if (ex.status === 401) return showLogin('Your session ended. Sign in again.');
        state.webhookError = ex;
      }
      renderMain();
    } },
    h('label', { class: 'field grow', for: 'paypalWebhookId' }, h('span', { class: 'label' }, 'PayPal Webhook ID'), idInput,
      h('span', { class: 'hint' }, 'Shown in the PayPal Developer Dashboard after you add the webhook. It is not your Client ID.')),
    h('div', { class: 'field' }, h('span', { class: 'label' }, '\u00A0'), save));
    return h('section', { class: 'panel' },
      h('h2', { class: 'section' }, 'Webhooks from PayPal'),
      h('dl', { class: 'facts' },
        h('dt', null, 'Receiver URL'), h('dd', null, h('span', { class: 'mono' }, w.receiverUrl), ' ', copy),
        h('dt', null, 'PayPal Webhook ID'), h('dd', null, w.paypalWebhookId ? h('span', { class: 'mono' }, w.paypalWebhookId) : 'Not set. Deliveries are stored but cannot be verified.'),
        h('dt', null, 'Your endpoint'), h('dd', { class: 'mono wrap' }, p.webhookEndpointUrl),
        h('dt', null, 'Forwarding'), h('dd', null, forwardModeControl(p))),
      w.receiverIsHttps ? null : h('div', { class: 'alert warn', role: 'status' },
        h('strong', null, 'This address is not public https.'),
        h('p', { class: 'alert-text' }, 'PayPal can only deliver to a public https address. Start an https tunnel to this computer, set PUBLIC_BASE_URL in .env to the tunnel address, and restart Faultline. Then copy the receiver URL again.')),
      h('ol', { class: 'guide' },
        h('li', null, 'In the PayPal Developer Dashboard open Apps & Credentials, switch to Sandbox, open your app, and find Webhooks.'),
        h('li', null, 'Add a webhook with the receiver URL above. Select the events you want (for example Checkout order approved and Payment capture completed), then save.'),
        h('li', null, 'Copy the Webhook ID PayPal shows and save it below. Use real Sandbox payments: events from the Webhooks Simulator cannot be verified.')),
      state.webhookError ? errorBox(state.webhookError) : null,
      form);
  }

  function eventsSection(p) {
    const f = state.eventFilters;
    const status = h('select', { id: 'filterStatus', 'aria-label': 'Verification status', onchange: (e) => { f.status = e.target.value; reloadEvents(p); } },
      [['', 'All verification states'], ['verified', 'Verified'], ['failed', 'Verification failed'], ['error', 'Could not verify'], ['unverified', 'Not verified']]
        .map(([v, l]) => h('option', { value: v, selected: v === f.status }, l)));
    const type = h('select', { id: 'filterType', 'aria-label': 'Event type', onchange: (e) => { f.type = e.target.value; reloadEvents(p); } },
      [h('option', { value: '' }, 'All event types'), ...state.eventTypes.map((t) => h('option', { value: t, selected: t === f.type }, t))]);
    const q = h('input', { id: 'filterQ', type: 'search', placeholder: 'Search event ID or resource ID', value: f.q, autocomplete: 'off',
      oninput: (e) => { f.q = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); reloadEvents(p); } } });
    const refresh = h('button', { class: 'btn', type: 'button', onclick: () => eventAction(p, refresh, 'Loading\u2026', async () => {}) }, 'Refresh');

    const rows = state.events.map((e) => h('tr', { class: state.eventDetail && state.eventDetail.event.id === e.id ? 'selected' : null },
      h('td', null, fmtTime(e.receivedAt)),
      h('td', { class: 'mono' }, e.eventType || '\u2014'),
      h('td', { class: 'mono' }, e.paypalEventId || '\u2014'),
      h('td', { class: 'mono' }, e.resourceId || '\u2014'),
      h('td', null, verifyBadge(e.verification.status)),
      h('td', null, pretty(e.processingStatus)),
      h('td', { class: 'mono' }, e.relatedOrder && e.relatedOrder.paypalOrderId ? e.relatedOrder.paypalOrderId : 'Not linked'),
      h('td', null, e.deliveryCount),
      h('td', null, h('button', { class: 'btn', type: 'button', onclick: () => openEvent(p, e.id) }, 'Open'))));

    const explorer = h('section', { class: 'panel' },
      h('h2', { class: 'section' }, 'Event explorer'),
      h('p', { class: 'hint-text' }, 'Every delivery that reaches the receiver URL is stored here exactly as received, with the verdict PayPal gave on its signature.'),
      h('div', { class: 'row-form' }, status, type, q, refresh),
      state.eventError && !state.eventDetail ? errorBox(state.eventError) : null,
      state.events.length === 0
        ? h('p', { class: 'empty' }, state.eventTotal === 0 && !f.status && !f.type && !f.q ? 'No webhook deliveries yet. They appear here as soon as PayPal (or anyone) calls the receiver URL.' : 'No events match these filters.')
        : h('div', { class: 'table-wrap' }, h('table', { class: 'checks' },
          h('thead', null, h('tr', null, ['Received', 'Event type', 'PayPal event ID', 'Resource ID', 'Verification', 'Processing', 'Faultline order', 'Deliveries', ''].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, rows))),
      state.events.length ? h('p', { class: 'hint-text spaced-top' }, `Showing ${state.events.length} of ${state.eventTotal}.`) : null);

    const parts = [explorer];
    if (state.eventDetail) parts.push(eventDetailPanel(p));
    parts.push(runsPanel(p));
    if (state.runDetail) parts.push(runDetailPanel(p));
    parts.push(aiEngineerPanel(p));
    parts.push(reportsPanel(p));
    parts.push(deliveriesPanel());
    return parts;
  }

  async function reloadEvents(p) {
    state.eventError = null;
    try { await loadEventData(p.id); } catch (ex) { if (ex.status === 401) return showLogin('Your session ended. Sign in again.'); state.eventError = ex; }
    renderMain();
  }

  async function openEvent(p, eventId) {
    state.eventError = null;
    try { state.eventDetail = await api('GET', `/api/projects/${p.id}/events/${eventId}`); } catch (ex) { state.eventError = ex; }
    renderMain();
  }

  function eventDetailPanel(p) {
    const d = state.eventDetail;
    const e = d.event;
    const v = e.verification;
    const reverify = e.verification.status === 'verified' ? null : h('button', { class: 'btn primary', type: 'button', onclick: () => eventAction(p, reverify, 'Asking PayPal\u2026', async () => {
      state.eventDetail = await api('POST', `/api/projects/${p.id}/events/${e.id}/reverify`);
    }) }, 'Verify again');
    const headerRows = Object.entries(d.headers).map(([k, val]) => h('tr', null, h('td', { class: 'mono' }, k), h('td', { class: 'mono wrap' }, val)));
    const deliveryRows = d.deliveries.map((x) => h('tr', null,
      h('td', null, fmtTime(x.receivedAt)), h('td', null, verifyBadge(x.verificationStatus)), h('td', { class: 'mono' }, x.responseStatus),
      h('td', null, x.isRedelivery ? 'Yes (same event again)' : 'First delivery'), h('td', null, `${x.bodyBytes} bytes`)));
    return h('section', { class: 'panel' },
      h('div', { class: 'title-row' },
        h('h2', { class: 'section nomargin' }, e.eventType || 'Event'), verifyBadge(v.status),
        h('div', { class: 'actions' }, reverify)),
      state.eventError ? errorBox(state.eventError) : null,
      v.status === 'verified' ? null : h('div', { class: `alert ${v.status === 'failed' ? 'bad' : v.status === 'error' ? 'warn' : 'idle'}`, role: 'status' },
        h('strong', null, `${VERIFY[v.status].label}.`), h('p', { class: 'alert-text' }, v.detail), v.code ? h('p', { class: 'code' }, `Code: ${v.code}`) : null),
      h('dl', { class: 'facts' },
        h('dt', null, 'PayPal event ID'), h('dd', { class: 'mono' }, e.paypalEventId || '\u2014'),
        h('dt', null, 'Resource ID'), h('dd', { class: 'mono' }, e.resourceId || '\u2014'),
        h('dt', null, 'Resource type'), h('dd', null, e.resourceType || '\u2014'),
        h('dt', null, 'Original delivery time'), h('dd', null, e.originalDeliveryTime ? `${e.originalDeliveryTime} (PayPal transmission time header)` : '\u2014'),
        h('dt', null, 'Event created by PayPal'), h('dd', null, e.paypalEventCreatedAt || '\u2014'),
        h('dt', null, 'Received by Faultline'), h('dd', null, fmtTime(e.receivedAt)),
        h('dt', null, 'Processing status'), h('dd', null, PROCESSING_TEXT[e.processingStatus] || pretty(e.processingStatus)),
        h('dt', null, 'Faultline order'), h('dd', null, e.relatedOrder ? `Linked to order ${e.relatedOrder.paypalOrderId || e.relatedOrder.id}` : 'Not linked to an order Faultline created'),
        h('dt', null, 'Size'), h('dd', null, `${d.rawBytes} bytes`)),
      scenarioLab(p, d),
      h('h2', { class: 'section spaced' }, 'Delivery history'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'checks' },
        h('thead', null, h('tr', null, ['Received', 'Verification', 'Our response', 'Kind', 'Size'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, deliveryRows))),
      h('details', { class: 'raw-wrap' }, h('summary', null, 'Headers saved with this event'),
        h('div', { class: 'table-wrap' }, h('table', { class: 'checks' }, h('tbody', null, headerRows)))),
      d.payload ? h('details', { class: 'raw-wrap' }, h('summary', null, 'Payload (formatted for reading)'), h('pre', { class: 'raw' }, JSON.stringify(d.payload, null, 2))) : null,
      h('details', { class: 'raw-wrap' }, h('summary', null, 'Raw body (exact bytes as received)'), h('pre', { class: 'raw' }, d.rawText)));
  }

  function deliveriesPanel() {
    const rows = state.deliveries.map((x) => h('tr', null,
      h('td', null, fmtTime(x.receivedAt)), h('td', null, verifyBadge(x.verificationStatus)), h('td', { class: 'mono' }, x.responseStatus),
      h('td', { class: 'mono' }, x.eventType || '\u2014'), h('td', { class: 'mono' }, x.paypalEventId || '\u2014'),
      h('td', null, x.isRedelivery ? 'Redelivery' : x.eventId ? 'First' : 'No event stored'),
      h('td', { class: 'wrap' }, x.note || '\u2014')));
    return h('section', { class: 'panel' },
      h('h2', { class: 'section' }, 'Recent inbound deliveries'),
      state.deliveries.length === 0
        ? h('p', { class: 'empty' }, 'Nothing has reached the receiver URL yet.')
        : h('div', { class: 'table-wrap' }, h('table', { class: 'checks' },
          h('thead', null, h('tr', null, ['Received', 'Verification', 'Our response', 'Event type', 'PayPal event ID', 'Kind', 'Note'].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, rows))));
  }


  // ---- test lab: forwarding and fault injection ---------------------------
  const PROCESSING_TEXT = {
    stored: 'Stored exactly as received. Not forwarded yet.',
    forwarded: 'Forwarded to your endpoint at least once, and your endpoint accepted it with a 2xx reply.',
    forward_failed: 'Forwarding was attempted, but your endpoint did not accept it. See the scenario runs below.',
    dropped: 'Deliberately dropped by a test. Nothing was sent to your endpoint.',
  };
  const RUN_CLS = { completed: 'ok', failed: 'bad', cancelled: 'idle', scheduled: 'warn', queued: 'warn', running: 'warn' };
  const RUN_TEXT = { completed: 'Completed', failed: 'Failed to run', cancelled: 'Cancelled', scheduled: 'Waiting to send', queued: 'Starting', running: 'Running' };
  const runBadge = (status) => h('span', { class: `badge ${RUN_CLS[status] || 'idle'}` }, RUN_TEXT[status] || pretty(status));
  const OUTCOME = {
    delivered: ['ok', 'Accepted (2xx)'], http_error: ['bad', 'Rejected by endpoint'], redirect_not_followed: ['warn', 'Redirect (not followed)'],
    timeout: ['warn', 'Timed out'], network_error: ['warn', 'Could not connect'], dropped: ['idle', 'Dropped on purpose'], blocked: ['bad', 'Blocked'],
  };
  const outcomeBadge = (o) => { const [c, l] = OUTCOME[o] || ['idle', pretty(o)]; return h('span', { class: `badge ${c}` }, l); };
  const KIND_TEXT = { original: 'Original', duplicate: 'Duplicate', delayed: 'Delayed', replay: 'Replay', dropped: 'Dropped' };
  const SCENARIOS = {
    forward: ['Forward once', 'Sends the stored event to your endpoint one time, exactly as PayPal sent it.'],
    duplicate: ['Duplicate delivery', 'Sends the same event several times, one after another or all at once, to see whether your app handles it more than once.'],
    delay: ['Delayed delivery', 'Holds the event and delivers it after the delay you choose, so your app sees it later than normal.'],
    drop: ['Dropped delivery', 'Deliberately sends nothing, to see what your app does when an expected event never arrives.'],
    replay: ['Replay delivery', 'Sends a previously received event again, labeled as a replay.'],
  };
  const activeRun = (r) => ['queued', 'scheduled', 'running'].includes(r.status);

  async function loadRunData(projectId) {
    state.runs = (await api('GET', `/api/projects/${projectId}/scenario-runs`)).runs;
  }

  // While a scenario is waiting or running, refresh every second. Skips a refresh while you are typing.
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (state.view !== 'detail' || !state.detail) return;
    if (!(state.runs.some(activeRun) || (state.runDetail && activeRun(state.runDetail.run)))) return;
    const projectId = state.detail.project.id;
    pollTimer = setTimeout(async () => {
      if (!state.detail || state.detail.project.id !== projectId) return;
      const el = document.activeElement;
      if (el && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && document.getElementById('main').contains(el)) return schedulePoll();
      try {
        await loadRunData(projectId);
        if (state.runDetail) state.runDetail = await api('GET', `/api/projects/${projectId}/scenario-runs/${state.runDetail.run.id}`);
        await loadEventData(projectId);
        if (state.eventDetail) state.eventDetail = await api('GET', `/api/projects/${projectId}/events/${state.eventDetail.event.id}`);
      } catch (ex) {
        if (ex.status === 401) return showLogin('Your session ended. Sign in again.');
      }
      renderMain();
    }, 1000);
  }

  function forwardModeControl(p) {
    const sel = h('select', { id: 'forwardMode', 'aria-label': 'Forwarding mode', onchange: async (e) => {
      sel.disabled = true;
      try {
        const data = await api('PATCH', `/api/projects/${p.id}`, { forwardMode: e.target.value });
        state.detail = { project: data.project, checks: data.checks };
        state.webhookError = null;
      } catch (ex) { if (ex.status === 401) return showLogin('Your session ended. Sign in again.'); state.webhookError = ex; }
      renderMain();
    } },
    h('option', { value: 'manual', selected: p.forwardMode === 'manual' }, 'Manual: hold events until I run a test'),
    h('option', { value: 'auto', selected: p.forwardMode === 'auto' }, 'Automatic: forward each new verified event once'));
    return h('span', null, sel, h('span', { class: 'hint block' }, p.forwardMode === 'auto'
      ? 'Each new verified event is sent to your endpoint once, as it arrives. PayPal\u2019s own repeat deliveries are recorded but not forwarded again.'
      : 'Events wait in the explorer. Nothing reaches your endpoint until you run a scenario. Choose this to test dropped and delayed deliveries.'));
  }

  function scenarioLab(p, d) {
    const e = d.event;
    if (e.verification.status !== 'verified') {
      return h('div', { class: 'lab' }, h('h2', { class: 'section spaced' }, 'Test lab'),
        h('p', { class: 'empty' }, 'Only events that PayPal verified can be forwarded or used in tests. Verify this event first.'));
    }
    const f = state.scenarioForm;
    const kind = h('select', { id: 'scenarioKind', onchange: (ev) => { f.kind = ev.target.value; renderMain(); } },
      Object.entries(SCENARIOS).map(([k, [label]]) => h('option', { value: k, selected: k === f.kind }, label)));
    const extra = [];
    if (f.kind === 'duplicate') {
      extra.push(h('label', { class: 'field', for: 'scenarioCount' }, h('span', { class: 'label' }, 'Total deliveries'),
        h('input', { id: 'scenarioCount', type: 'number', min: '2', max: '10', value: f.count, oninput: (ev) => { f.count = ev.target.value; } })));
      extra.push(h('label', { class: 'field', for: 'scenarioMode' }, h('span', { class: 'label' }, 'Timing'),
        h('select', { id: 'scenarioMode', onchange: (ev) => { f.mode = ev.target.value; } },
          h('option', { value: 'sequential', selected: f.mode === 'sequential' }, 'One after another'),
          h('option', { value: 'concurrent', selected: f.mode === 'concurrent' }, 'All at the same time'))));
    }
    if (f.kind === 'delay') {
      extra.push(h('label', { class: 'field', for: 'scenarioDelay' }, h('span', { class: 'label' }, 'Delay (seconds)'),
        h('input', { id: 'scenarioDelay', type: 'number', min: '1', max: '3600', value: f.delaySeconds, oninput: (ev) => { f.delaySeconds = ev.target.value; } })));
    }
    const go = h('button', { class: 'btn primary', type: 'submit' }, f.kind === 'drop' ? 'Drop this event' : 'Run scenario');
    const form = h('form', { class: 'row-form', novalidate: true, onsubmit: async (ev) => {
      ev.preventDefault();
      go.disabled = true; go.textContent = 'Starting\u2026';
      state.runError = null;
      const body = { kind: f.kind, idempotencyKey: state.scenarioKey };
      if (f.kind === 'duplicate') { body.count = f.count; body.mode = f.mode; }
      if (f.kind === 'delay') body.delaySeconds = f.delaySeconds;
      try {
        const data = await api('POST', `/api/projects/${p.id}/events/${e.id}/scenarios`, body);
        state.scenarioKey = newKey();
        state.runDetail = await api('GET', `/api/projects/${p.id}/scenario-runs/${data.run.id}`);
        await loadRunData(p.id);
        state.eventDetail = await api('GET', `/api/projects/${p.id}/events/${e.id}`);
      } catch (ex) {
        if (ex.status === 401) return showLogin('Your session ended. Sign in again.');
        state.runError = ex;
      }
      renderMain();
    } },
    h('label', { class: 'field', for: 'scenarioKind' }, h('span', { class: 'label' }, 'Scenario'), kind), ...extra,
    h('div', { class: 'field' }, h('span', { class: 'label' }, '\u00A0'), go));
    return h('div', { class: 'lab' },
      h('h2', { class: 'section spaced' }, 'Test lab'),
      h('p', { class: 'hint-text' }, `${SCENARIOS[f.kind][1]} Destination: `, h('span', { class: 'mono' }, p.webhookEndpointUrl)),
      form,
      state.runError ? errorBox(state.runError) : null,
      h('p', { class: 'hint-text' }, 'The event body and PayPal\u2019s signature headers are sent unchanged, so your app can run its normal signature check. If your app rejects old timestamps, delayed and replayed deliveries may be refused. That is a real result, not a Faultline error. Repeating a webhook never creates a payment.'),
      d.runs.length ? h('p', { class: 'hint-text' }, `Runs on this event: ${d.runs.map((r) => `${SCENARIOS[r.kind][0]} (${RUN_TEXT[r.status] || r.status})`).join(', ')}.`) : null);
  }

  function runsPanel(p) {
    const shown = state.runs.filter((r) => !state.runFilter || r.verdict === state.runFilter);
    const filter = h('select', { id: 'runFilter', 'aria-label': 'Verdict filter', onchange: (e) => { state.runFilter = e.target.value; renderMain(); } },
      [['', 'All verdicts'], ['passed', 'Passed'], ['failed', 'Failed'], ['inconclusive', 'Inconclusive']].map(([v, l]) => h('option', { value: v, selected: v === state.runFilter }, l)));
    const rows = shown.map((r) => h('tr', { class: state.runDetail && state.runDetail.run.id === r.id ? 'selected' : null },
      h('td', null, fmtTime(r.createdAt)),
      h('td', null, r.label, r.triggeredBy === 'auto' ? ' (automatic)' : r.triggeredBy === 'ai_plan' ? ' (from AI plan)' : ''),
      h('td', { class: 'mono' }, r.paypalEventId || '\u2014'),
      h('td', null, runBadge(r.status)),
      h('td', null, verdictBadge(r.verdict)),
      h('td', null, r.dropped ? 'None (dropped)' : `${r.requestsSent} of ${r.plannedAttempts}`),
      h('td', { class: 'mono' }, r.statusCodes.length ? r.statusCodes.map((c) => c ?? 'no reply').join(', ') : '\u2014'),
      h('td', null, h('button', { class: 'btn', type: 'button', onclick: async () => {
        state.runError = null;
        try { state.runDetail = await api('GET', `/api/projects/${p.id}/scenario-runs/${r.id}`); } catch (ex) { state.runError = ex; }
        renderMain();
      } }, 'Open'))));
    return h('section', { class: 'panel' },
      h('h2', { class: 'section' }, 'Test history'),
      h('p', { class: 'hint-text' }, 'Every forward, duplicate, delayed, dropped and replayed delivery, with what your endpoint answered and the verdict from the checks.'),
      state.runs.length ? h('div', { class: 'row-form' }, filter) : null,
      state.runs.length === 0 ? h('p', { class: 'empty' }, 'No scenarios yet. Open a verified event above and run one.')
        : shown.length === 0 ? h('p', { class: 'empty' }, 'No runs have this verdict.')
        : h('div', { class: 'table-wrap' }, h('table', { class: 'checks' },
          h('thead', null, h('tr', null, ['Created', 'Scenario', 'PayPal event ID', 'Status', 'Verdict', 'Requests sent', 'HTTP replies', ''].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, rows))));
  }

  function runDetailPanel(p) {
    const { run, attempts, result, aiAnalysis } = state.runDetail;
    const cancel = run.status === 'scheduled' ? h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      try {
        await api('POST', `/api/projects/${p.id}/scenario-runs/${run.id}/cancel`);
        state.runDetail = await api('GET', `/api/projects/${p.id}/scenario-runs/${run.id}`);
        await loadRunData(p.id);
      } catch (ex) { state.runError = ex; }
      renderMain();
    } }, 'Cancel') : null;
    const canAnalyze = ['completed', 'failed', 'cancelled'].includes(run.status);
    const analyzeBtn = canAnalyze ? h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      analyzeBtn.disabled = true; analyzeBtn.textContent = 'Analyzing evidence\u2026';
      state.aiAnalysisError = null;
      try {
        const data = await api('POST', `/api/projects/${p.id}/scenario-runs/${run.id}/analyze`);
        state.aiAnalysis = data.analysis;
        state.aiAnalysisRunId = run.id;
        state.runDetail = await api('GET', `/api/projects/${p.id}/scenario-runs/${run.id}`);
      } catch (ex) {
        if (ex.status === 401) return showLogin('Your session ended. Sign in again.');
        state.aiAnalysisError = ex;
      }
      renderMain();
    } }, aiAnalysis ? 'Re-analyze evidence' : 'Analyze with AI Test Engineer') : null;
    const secs = (ms) => (ms === null || ms === undefined ? '\u2014' : `${(ms / 1000).toFixed(1)} s`);
    const attemptRows = attempts.map((a) => h('tr', null,
      h('td', null, `${a.attemptNo} of ${run.plannedAttempts}`),
      h('td', null, KIND_TEXT[a.deliveryKind] || a.deliveryKind),
      h('td', null, a.outcome === 'dropped' ? '\u2014' : fmtTime(a.sentAt)),
      h('td', null, outcomeBadge(a.outcome)),
      h('td', { class: 'mono' }, a.httpStatus ?? '\u2014'),
      h('td', null, a.outcome === 'dropped' ? '\u2014' : `${a.durationMs} ms`),
      h('td', { class: 'mono wrap' }, a.responseSnippet ? a.responseSnippet.slice(0, 200) : (a.errorText || '\u2014'))));
    const sample = attempts.find((a) => Object.keys(a.requestHeaders).length);
    return h('section', { class: 'panel' },
      h('div', { class: 'title-row' }, h('h2', { class: 'section nomargin' }, result.scenarioLabel), runBadge(run.status), h('div', { class: 'actions' }, analyzeBtn, cancel)),
      state.runError ? errorBox(state.runError) : null,
      result.dropped ? h('div', { class: 'alert idle', role: 'status' }, h('strong', null, 'Deliberately dropped.'), h('p', { class: 'alert-text' }, 'Faultline held this event back on purpose. Your endpoint received nothing from this run.')) : null,
      run.status === 'scheduled' ? h('div', { class: 'alert warn', role: 'status' }, h('strong', null, 'Waiting to send.'), h('p', { class: 'alert-text' }, `Scheduled for ${fmtTime(run.scheduledFor)}. If Faultline restarts first, the run is picked up again.`)) : null,
      run.errorText && run.status !== 'cancelled' ? h('div', { class: 'alert bad', role: 'alert' }, h('strong', null, 'Faultline could not finish this scenario.'), h('p', { class: 'alert-text' }, run.errorText)) : null,
      h('dl', { class: 'facts' },
        h('dt', null, 'Original PayPal event'), h('dd', { class: 'mono' }, result.originalEventId || '\u2014'),
        h('dt', null, 'Destination'), h('dd', { class: 'mono wrap' }, result.destination),
        h('dt', null, 'Scenario completed'), h('dd', null, result.completed ? 'Yes. Every planned step ran.' : run.status === 'cancelled' ? 'No. Cancelled before it was sent.' : activeRun(run) ? 'Not yet.' : 'No.'),
        h('dt', null, 'Requests sent'), h('dd', null, result.dropped ? 'None (dropped on purpose)' : `${result.requestsSent} of ${result.plannedAttempts} planned`),
        h('dt', null, 'HTTP replies'), h('dd', { class: 'mono' }, result.statusCodes.length ? result.statusCodes.map((c) => c ?? 'no reply').join(', ') : '\u2014'),
        h('dt', null, 'Accepted / rejected / no reply'), h('dd', null, `${result.acceptedCount} / ${result.rejectedCount} / ${result.failedCount}`),
        h('dt', null, 'Started'), h('dd', null, fmtTime(result.startedAt)),
        h('dt', null, 'Finished'), h('dd', null, result.finishedAt ? `${fmtTime(result.finishedAt)} (took ${secs(result.totalMs)})` : '\u2014'),
        result.delay ? [
          h('dt', null, 'Delay requested'), h('dd', null, `${result.delay.requestedSeconds} s`),
          h('dt', null, 'Event received by Faultline'), h('dd', null, fmtTime(result.delay.eventReceivedAt)),
          h('dt', null, 'Actually forwarded'), h('dd', null, result.delay.forwardedAt ? `${fmtTime(result.delay.forwardedAt)} (waited ${secs(result.delay.waitedMs)} after the run was created, ${secs(result.delay.heldForMs)} after the event arrived)` : 'Not yet'),
        ] : null),
      h('h2', { class: 'section spaced' }, 'What Faultline observed'),
      h('ul', { class: 'plain' }, result.observations.map((o) => h('li', null, o))),
      result.errors.length ? h('ul', { class: 'plain' }, result.errors.map((x) => h('li', null, `Attempt ${x.attempt}: ${x.message}`))) : null,
      verdictBox(result),
      assertionsTable(state.runDetail),
      snapshotsTable(state.runDetail),
      result.risks && result.risks.length ? h('div', { class: 'alert idle', role: 'status' }, h('strong', null, 'Inferred risks (suspicions, not verdicts)'), h('ul', null, result.risks.map((x) => h('li', null, x)))) : null,
      aiAnalysis ? aiAnalysisView(aiAnalysis) : null,
      h('h2', { class: 'section spaced' }, 'Delivery attempts'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'checks' },
        h('thead', null, h('tr', null, ['Attempt', 'Kind', 'Sent at', 'Outcome', 'HTTP', 'Took', 'Reply or error'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, attemptRows))),
      sample ? h('details', { class: 'raw-wrap' }, h('summary', null, 'Headers Faultline sent with the first attempt'),
        h('div', { class: 'table-wrap' }, h('table', { class: 'checks' }, h('tbody', null, Object.entries(sample.requestHeaders).map(([k, v]) => h('tr', null, h('td', { class: 'mono' }, k), h('td', { class: 'mono wrap' }, v))))))) : null);
  }


  // ---- phase 5: overview, probe, verdicts, reports ------------------------
  const VERDICT = { passed: ['ok', 'Passed'], failed: ['bad', 'Failed'], inconclusive: ['warn', 'Inconclusive'] };
  const verdictBadge = (v) => { const x = VERDICT[v]; return x ? h('span', { class: `badge ${x[0]}` }, x[1]) : h('span', { class: 'badge idle' }, 'Pending'); };
  const CHECK = { pass: ['ok', 'Pass'], fail: ['bad', 'Fail'], not_evaluable: ['warn', 'Not evaluable'], not_applicable: ['idle', 'Not applicable'] };
  const CATEGORY = { integrity: 'Test integrity', delivery: 'Delivery', invariant: 'Your application\u2019s state', platform: 'Fact about PayPal' };
  const EVIDENCE = { observed: 'Observed by Faultline', probe: 'From your probe', paypal: 'Reported by PayPal', assumption: 'Assumption' };

  function verdictBox(result) {
    const v = result.verdict.status;
    const cls = v === 'passed' ? 'ok' : v === 'failed' ? 'bad' : 'idle';
    const title = v === 'not_evaluated' ? 'Verdict: not yet available' : `Verdict: ${(VERDICT[v] || [0, v])[1]}`;
    return h('div', { class: `alert ${cls}`, role: 'status' }, h('strong', null, title), h('p', { class: 'alert-text' }, result.verdict.message));
  }

  function assertionsTable(d) {
    if (!d.assertions.length) return null;
    const rows = d.assertions.map((a) => {
      const [cls, label] = CHECK[a.verdict] || ['idle', a.verdict];
      return h('tr', null,
        h('td', null, h('strong', null, a.name), h('div', { class: 'hint block' }, CATEGORY[a.category] || a.category)),
        h('td', null, h('span', { class: `badge ${cls}` }, label)),
        h('td', { class: 'wrap' }, a.summary,
          a.evidence.length ? h('ul', { class: 'plain evidence' }, a.evidence.map((e) => h('li', null, h('span', { class: 'tag' }, EVIDENCE[e.type] || e.type), ' ', e.text))) : null));
    });
    return h('div', null,
      h('h2', { class: 'section spaced' }, 'Checks'),
      h('p', { class: 'hint-text' }, 'Each check says pass or fail only when it has the evidence it needs. Otherwise it says not evaluable, and that is never counted as a pass.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'checks' },
        h('thead', null, h('tr', null, ['Check', 'Result', 'What was found'].map((t) => h('th', { scope: 'col' }, t)))), h('tbody', null, rows))));
  }

  function snapshotsTable(d) {
    if (!d.snapshots.length) return null;
    const describe = (x) => {
      if (x.outcome !== 'ok') return x.errorText || 'Could not be read.';
      const v = x.data || {};
      if (x.source === 'probe') {
        const money = (c) => (c === null || c === undefined ? 'not reported' : (c / 100).toFixed(2));
        return `processed_count ${v.processedCount ?? 'not reported'}; status ${v.status || 'not reported'}; captured ${money(v.capturedCents)}; refunded ${money(v.refundedCents)}; payment_records ${v.paymentRecords ?? 'not reported'}`;
      }
      return `order status ${v.orderStatus || 'unknown'}; captures at PayPal ${v.captureCount}`;
    };
    const rows = d.snapshots.map((x) => h('tr', null,
      h('td', null, x.source === 'probe' ? 'Your probe' : 'PayPal order'), h('td', null, x.phase === 'before' ? 'Before the scenario' : 'After the scenario'),
      h('td', null, x.outcome === 'ok' ? 'Read' : 'Failed'), h('td', { class: 'mono wrap' }, describe(x))));
    return h('div', null, h('h2', { class: 'section spaced' }, 'Evidence read before and after'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'checks' },
        h('thead', null, h('tr', null, ['Source', 'When', 'Result', 'What it reported'].map((t) => h('th', { scope: 'col' }, t)))), h('tbody', null, rows))));
  }

  function overviewPanel() {
    const o = state.overview;
    if (!o) return null;
    const tile = (label, value, note) => h('div', { class: 'tile' }, h('div', { class: 'tile-value' }, String(value)), h('div', { class: 'tile-label' }, label), note ? h('div', { class: 'tile-note' }, note) : null);
    const out = o.forwardAttempts.byOutcome;
    const accepted = out.delivered || 0; const dropped = out.dropped || 0; const blocked = out.blocked || 0;
    const notAccepted = o.forwardAttempts.total - accepted - dropped - blocked;
    const v = o.runs.byVerdict;
    return h('section', { class: 'panel' },
      h('h2', { class: 'section' }, 'Overview'),
      h('p', { class: 'hint-text' }, 'Counts of what is stored for this project. Nothing here is estimated or sample data.'),
      h('div', { class: 'tiles' },
        tile('Sandbox orders', o.orders.total, `${o.captures.total} captured`),
        tile('Webhook events', o.events.total, `${o.events.byVerification.verified || 0} verified by PayPal`),
        tile('Inbound deliveries', o.inboundDeliveries.total, `${o.inboundDeliveries.redeliveries} were redeliveries`),
        tile('Deliveries to your endpoint', o.forwardAttempts.total, `${accepted} accepted, ${notAccepted} not accepted, ${dropped} dropped`),
        tile('Scenario runs', o.runs.total, `${v.passed || 0} passed, ${v.failed || 0} failed, ${v.inconclusive || 0} inconclusive`),
        tile('Failed checks', o.failedChecks),
        tile('PayPal API calls', o.paypalCalls)),
      o.probeConfigured ? null : h('p', { class: 'hint-text spaced-top' }, 'No state probe is set up, so no verdict can be \u201cpassed\u201d yet. See State probe below.'));
  }

  const PROBE_EXAMPLE = `GET <your probe URL>?event_id=WH-...&resource_id=...&event_type=PAYMENT.CAPTURE.COMPLETED

{
  "event":   { "processed_count": 1 },
  "payment": { "status": "COMPLETED",
               "captured_amount": "10.10",
               "refunded_amount": "0.00",
               "currency": "USD",
               "payment_records": 1 }
}`;
  const PROBE_CODE = `// Express example. Add it only to a TEST environment: it exposes your payment state.
app.get('/faultline-probe', async (req, res) => {
  const seen = await db.get('SELECT COUNT(*) AS n FROM processed_events WHERE paypal_event_id = ?', req.query.event_id);
  const pay = await db.get('SELECT status, captured, refunded, currency FROM payments WHERE capture_id = ?', req.query.resource_id);
  const records = await db.get('SELECT COUNT(*) AS n FROM payments WHERE capture_id = ?', req.query.resource_id);
  res.json({
    event: { processed_count: seen.n },
    payment: pay ? { status: pay.status, captured_amount: pay.captured, refunded_amount: pay.refunded, currency: pay.currency, payment_records: records.n } : {},
  });
});`;

  function probePanel(p) {
    const input = h('input', { id: 'probeUrl', type: 'text', value: p.probeUrl || '', placeholder: 'http://localhost:4000/faultline-probe', autocomplete: 'off', spellcheck: 'false' });
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save probe URL');
    const test = h('button', { class: 'btn', type: 'button', disabled: !p.probeUrl, title: p.probeUrl ? '' : 'Save a probe URL first', onclick: async () => {
      test.disabled = true; test.textContent = 'Asking your probe\u2026';
      state.probeError = null; state.probeResult = null;
      try { state.probeResult = await api('POST', `/api/projects/${p.id}/probe/test`, {}); } catch (ex) { if (ex.status === 401) return showLogin('Your session ended. Sign in again.'); state.probeError = ex; }
      renderMain();
    } }, 'Test probe');
    const form = h('form', { class: 'row-form', novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      save.disabled = true; save.textContent = 'Saving\u2026';
      state.probeError = null; state.probeResult = null;
      try {
        const data = await api('PATCH', `/api/projects/${p.id}`, { probeUrl: input.value });
        state.detail = { project: data.project, checks: data.checks };
      } catch (ex) { if (ex.status === 401) return showLogin('Your session ended. Sign in again.'); state.probeError = ex; }
      try { await loadEventData(p.id); } catch { /* keep what we have */ }
      renderMain();
    } },
    h('label', { class: 'field grow', for: 'probeUrl' }, h('span', { class: 'label' }, 'State probe URL (optional)'), input,
      h('span', { class: 'hint' }, 'A test-only GET endpoint in your application that reports its own payment state.')),
    h('div', { class: 'field' }, h('span', { class: 'label' }, '\u00A0'), h('span', { class: 'btn-row' }, save, test)));
    const r = state.probeResult && state.probeResult.result;
    const result = r ? (r.outcome === 'ok'
      ? h('div', { class: 'alert ok', role: 'status' }, h('strong', null, `Your probe answered (HTTP ${r.httpStatus}, ${r.durationMs} ms) about ${state.probeResult.askedAbout}.`),
        h('p', { class: 'alert-text mono' }, `processed_count ${r.data.processedCount ?? 'not reported'}; status ${r.data.status || 'not reported'}; captured ${r.data.capturedCents === null ? 'not reported' : (r.data.capturedCents / 100).toFixed(2)}; refunded ${r.data.refundedCents === null ? 'not reported' : (r.data.refundedCents / 100).toFixed(2)}; payment_records ${r.data.paymentRecords ?? 'not reported'}`),
        h('p', { class: 'alert-text' }, 'A check runs only for fields your probe reports.'))
      : h('div', { class: 'alert bad', role: 'alert' }, h('strong', null, 'The probe did not give a usable answer.'), h('p', { class: 'alert-text' }, r.errorText))) : null;
    return h('section', { class: 'panel' },
      h('h2', { class: 'section' }, 'State probe (optional)'),
      h('p', { class: 'hint-text' }, 'Faultline cannot see inside your application. Without a probe it can only see HTTP replies, so no payment-safety verdict can be \u201cpassed\u201d. With a probe, it reads your application\u2019s own state before and after each scenario and checks it.'),
      form,
      state.probeError ? errorBox(state.probeError) : null,
      result,
      h('details', { class: 'raw-wrap' }, h('summary', null, 'What your probe must return'),
        h('p', { class: 'hint-text' }, 'Every field is optional. A check runs only when the fields it needs are present. Use PayPal\u2019s status names (for example PENDING, COMPLETED, PARTIALLY_REFUNDED, REFUNDED).'),
        h('pre', { class: 'raw' }, PROBE_EXAMPLE), h('pre', { class: 'raw' }, PROBE_CODE)));
  }

  function reportsPanel(p) {
    const rows = state.findings.map((f) => h('tr', null,
      h('td', null, h('strong', null, f.name), h('div', { class: 'hint block' }, CATEGORY[f.category] || f.category)),
      h('td', null, f.kind === 'failing' ? h('span', { class: 'badge bad' }, `Failed in ${f.failed} of ${f.runsEvaluated} runs`) : h('span', { class: 'badge warn' }, 'Never evaluated')),
      h('td', { class: 'wrap' }, f.guidance || '\u2014'),
      h('td', null, f.lastFailedRunId ? h('button', { class: 'btn', type: 'button', onclick: async () => {
        try { state.runDetail = await api('GET', `/api/projects/${p.id}/scenario-runs/${f.lastFailedRunId}`); } catch (ex) { state.runError = ex; }
        renderMain();
      } }, 'Open last failing run') : '')));
    return h('section', { class: 'panel' },
      h('h2', { class: 'section' }, 'Reports and reliability findings'),
      h('div', { class: 'actions-left' },
        h('a', { class: 'btn primary', href: `/api/projects/${p.id}/report?format=md`, download: '' }, 'Download report (Markdown)'),
        h('a', { class: 'btn', href: `/api/projects/${p.id}/report?format=json`, download: '' }, 'Download full evidence (JSON)')),
      h('p', { class: 'hint-text spaced-top' }, 'Exports contain only stored test evidence, with notices explaining what each label means. No secrets and no AI-written verdicts.'),
      state.findings.length === 0
        ? h('p', { class: 'empty' }, state.runs.length ? 'No failing checks, and every evaluated check was evaluated at least once.' : 'No findings yet. They appear after you run scenarios.')
        : h('div', { class: 'table-wrap' }, h('table', { class: 'checks' },
          h('thead', null, h('tr', null, ['Finding', 'Status', 'General guidance (not generated from your code)', ''].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, rows))));
  }

  // ---- phase 6: AI test engineer -----------------------------------------
  const EXAMPLE_PROMPTS = [
    ['Duplicate x2', 'Test whether my application processes the same completed payment webhook twice.'],
    ['Concurrent x3', 'Send 3 concurrent duplicate deliveries of the completed payment webhook at the same time.'],
    ['Delayed 10s', 'Hold the order approved webhook and deliver it after 10 seconds to test stale overwrite protection.'],
    ['Dropped', 'Drop the completed payment webhook to verify the payment state stays valid when a notification is lost.'],
    ['Replay', 'Replay the previously received completed payment webhook to check idempotency.'],
  ];

  function aiAnalysisView(a) {
    const dv = a.deterministicVerdict || {};
    const vCls = dv.status === 'passed' ? 'ok' : dv.status === 'failed' ? 'bad' : 'warn';
    const vLabel = (VERDICT[dv.status] || [0, dv.status || 'Not evaluated'])[1];
    return h('div', { class: 'ai-analysis' },
      h('h2', { class: 'section spaced' }, 'AI Test Engineer failure analysis'),
      h('div', { class: `alert ${vCls}`, role: 'status' },
        h('strong', null, `Deterministic verdict: ${vLabel} (locked)`),
        h('p', { class: 'alert-text' }, dv.notice || 'This verdict comes solely from Faultline\u2019s deterministic checks. The AI Test Engineer cannot alter or override it.')),
      a.insufficientEvidence ? h('div', { class: 'alert warn', role: 'status' },
        h('strong', null, 'Insufficient evidence to confirm internal state'),
        h('p', { class: 'alert-text' }, a.insufficientReason || 'Some application-state checks could not be evaluated from the available trace.')) : null,
      h('dl', { class: 'facts' },
        h('dt', null, 'What happened'), h('dd', null, a.whatHappened),
        h('dt', null, 'What was expected'), h('dd', null, a.whatWasExpected),
        h('dt', null, 'What actually happened'), h('dd', null, a.whatActuallyHappened),
        h('dt', null, 'Where failure occurred'), h('dd', null, a.whereFailureOccurred),
        h('dt', null, 'Why it matters'), h('dd', null, a.whyItMatters),
        h('dt', null, 'What to investigate'), h('dd', null, a.whatToInvestigate),
        h('dt', null, 'Remediation'), h('dd', null, a.remediation)),
      h('h3', { class: 'subsection spaced' }, 'Directly observed facts (from execution trace)'),
      h('ul', { class: 'plain' }, (a.observations || []).map((x) => h('li', null, h('span', { class: 'tag' }, 'Observed'), ' ', x))),
      h('h3', { class: 'subsection spaced' }, 'Assumptions and blind spots'),
      h('ul', { class: 'plain' }, (a.assumptions || []).map((x) => h('li', null, h('span', { class: 'tag' }, 'Assumption'), ' ', x))),
      h('h3', { class: 'subsection spaced' }, 'Concrete recommendations'),
      h('ul', { class: 'plain' }, (a.recommendations || []).map((x) => h('li', null, h('span', { class: 'tag' }, 'Recommendation'), ' ', x))));
  }

  function renderPlanSpec(p, plan) {
    const spec = plan.spec;
    const verifiedEvents = state.events.filter((e) => e.verification.status === 'verified');
    const selectedEvId = state.aiPlanEventId || plan.matchedEventId || (verifiedEvents[0] ? verifiedEvents[0].id : '');
    const evSelect = verifiedEvents.length
      ? h('select', { id: 'aiPlanEvent', 'aria-label': 'Verified source event', onchange: (e) => { state.aiPlanEventId = e.target.value; } },
        verifiedEvents.map((e) => h('option', { value: e.id, selected: e.id === selectedEvId }, `${e.eventType || 'Event'} (${e.paypalEventId || e.id.slice(0, 8)})`)))
      : null;

    const runBtn = h('button', {
      class: 'btn primary',
      type: 'button',
      disabled: !verifiedEvents.length || plan.validationStatus !== 'valid',
      title: verifiedEvents.length ? '' : 'Receive a PayPal-verified webhook event in this project before executing this test plan.',
      onclick: async () => {
        runBtn.disabled = true; runBtn.textContent = 'Starting scenario\u2026';
        state.aiPlanError = null;
        try {
          const evId = evSelect ? evSelect.value : plan.matchedEventId;
          const data = await api('POST', `/api/projects/${p.id}/ai/plans/${plan.id}/execute`, { eventId: evId, idempotencyKey: newKey() });
          state.aiSelectedPlan = data.plan;
          state.runDetail = await api('GET', `/api/projects/${p.id}/scenario-runs/${data.run.id}`);
          await loadEventData(p.id);
        } catch (ex) {
          if (ex.status === 401) return showLogin('Your session ended. Sign in again.');
          state.aiPlanError = ex;
        }
        renderMain();
      },
    }, 'Execute validated test plan');

    const assertionRows = (spec.assertions || []).map((a) => h('tr', null,
      h('td', null, h('strong', null, a.name), h('div', { class: 'hint block' }, CATEGORY[a.category] || a.category)),
      h('td', null, a.requiresProbe ? h('span', { class: 'badge warn' }, 'Requires state probe') : h('span', { class: 'badge ok' }, 'Observed / PayPal')),
      h('td', { class: 'wrap' }, a.criterion || '\u2014')));

    const paramSummary = spec.scenario.kind === 'duplicate'
      ? `${spec.scenario.params.count} deliveries (${spec.scenario.params.mode})`
      : spec.scenario.kind === 'delay'
        ? `Hold for ${spec.scenario.params.delaySeconds} second(s)`
        : spec.scenario.kind === 'drop'
          ? 'Withhold event (0 requests sent)'
          : '1 delivery';

    return h('div', { class: 'spec-box' },
      h('div', { class: 'title-row' },
        h('h3', { class: 'subsection nomargin' }, 'Structured test specification'),
        plan.validationStatus === 'valid' ? h('span', { class: 'badge ok' }, 'Validated specification') : h('span', { class: 'badge bad' }, 'Invalid specification'),
        plan.executedRunId ? h('span', { class: 'badge idle' }, 'Executed') : null),
      h('dl', { class: 'facts' },
        h('dt', null, 'Plain-English request'), h('dd', null, plan.prompt),
        h('dt', null, 'Test objective'), h('dd', null, spec.objective),
        h('dt', null, 'Required source event'), h('dd', null, h('span', { class: 'mono' }, spec.requiredSourceEvent.eventType), ' \u2014 ', spec.requiredSourceEvent.availabilityNote),
        h('dt', null, 'Fault scenario'), h('dd', null, `${spec.scenario.label} (${paramSummary})`),
        h('dt', null, 'Delivery attempts'), h('dd', null, `${spec.plannedAttempts} planned (${spec.requestsToSend} HTTP request(s) to send)`),
        h('dt', null, 'Expected behavior'), h('dd', null, spec.expectedBehavior),
        h('dt', null, 'Safety boundary'), h('dd', null, spec.safetyNotice)),
      h('h3', { class: 'subsection spaced' }, 'Deterministic assertions'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'checks' },
        h('thead', null, h('tr', null, ['Deterministic check', 'Evidence source', 'Pass criterion'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, assertionRows))),
      h('h3', { class: 'subsection spaced' }, 'Potential failure conditions'),
      h('ul', { class: 'plain' }, (spec.failureConditions || []).map((c) => h('li', null, c))),
      h('div', { class: 'row-form spaced-top' },
        evSelect ? h('label', { class: 'field grow', for: 'aiPlanEvent' }, h('span', { class: 'label' }, 'Run against verified event'), evSelect) : h('p', { class: 'empty' }, 'No PayPal-verified events are stored yet. Receive a verified webhook from PayPal Sandbox first.'),
        h('div', { class: 'field' }, h('span', { class: 'label' }, '\u00A0'), runBtn)));
  }

  function aiEngineerPanel(p) {
    const promptInput = h('input', {
      id: 'aiPrompt',
      type: 'text',
      value: state.aiPrompt,
      placeholder: 'For example: Test whether my application processes the same completed payment webhook twice.',
      autocomplete: 'off',
      oninput: (e) => { state.aiPrompt = e.target.value; },
    });
    const planBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Generate test plan');
    const planForm = h('form', { class: 'row-form', novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      planBtn.disabled = true; planBtn.textContent = 'Planning\u2026';
      state.aiPlanError = null;
      try {
        const data = await api('POST', `/api/projects/${p.id}/ai/plans`, { prompt: state.aiPrompt });
        state.aiSelectedPlan = data.plan;
        state.aiPlanEventId = data.plan.matchedEventId || '';
        await loadEventData(p.id);
      } catch (ex) {
        if (ex.status === 401) return showLogin('Your session ended. Sign in again.');
        state.aiPlanError = ex;
      }
      renderMain();
    } },
    h('label', { class: 'field grow', for: 'aiPrompt' }, h('span', { class: 'label' }, 'Describe a reliability test in plain English'), promptInput),
    h('div', { class: 'field' }, h('span', { class: 'label' }, '\u00A0'), planBtn));

    const quickBtns = h('div', { class: 'quick-prompts' },
      h('span', { class: 'hint' }, 'Examples: '),
      ...EXAMPLE_PROMPTS.map(([label, text]) => h('button', {
        class: 'btn small',
        type: 'button',
        onclick: () => { state.aiPrompt = text; renderMain(); },
      }, label)));

    // Failure analysis section for any completed/failed run
    const finishedRuns = state.runs.filter((r) => ['completed', 'failed', 'cancelled'].includes(r.status));
    const currentRunId = state.aiAnalysisRunId || (state.runDetail ? state.runDetail.run.id : (finishedRuns[0] ? finishedRuns[0].id : ''));
    const activeAnalysis = (state.runDetail && state.runDetail.aiAnalysis && state.runDetail.run.id === currentRunId)
      ? state.runDetail.aiAnalysis
      : (state.aiAnalysis && state.aiAnalysis.runId === currentRunId ? state.aiAnalysis : null);

    const runSelect = finishedRuns.length
      ? h('select', { id: 'aiAnalyzeRunSelect', 'aria-label': 'Finished scenario run to analyze', onchange: (e) => { state.aiAnalysisRunId = e.target.value; renderMain(); } },
        finishedRuns.map((r) => h('option', { value: r.id, selected: r.id === currentRunId }, `${r.label} on ${r.paypalEventId || r.eventType || 'event'} \u2014 ${r.verdict || r.status} (${fmtTime(r.createdAt)})`)))
      : null;

    const analyzeRunBtn = finishedRuns.length ? h('button', {
      class: 'btn primary',
      type: 'button',
      onclick: async () => {
        const targetId = runSelect ? runSelect.value : currentRunId;
        if (!targetId) return;
        analyzeRunBtn.disabled = true; analyzeRunBtn.textContent = 'Analyzing trace\u2026';
        state.aiAnalysisError = null;
        try {
          const data = await api('POST', `/api/projects/${p.id}/scenario-runs/${targetId}/analyze`);
          state.aiAnalysis = data.analysis;
          state.aiAnalysisRunId = targetId;
          if (state.runDetail && state.runDetail.run.id === targetId) {
            state.runDetail = await api('GET', `/api/projects/${p.id}/scenario-runs/${targetId}`);
          }
        } catch (ex) {
          if (ex.status === 401) return showLogin('Your session ended. Sign in again.');
          state.aiAnalysisError = ex;
        }
        renderMain();
      },
    }, 'Explain run from evidence') : null;

    // Suggestions section
    const sug = state.aiSuggestions;
    const suggestionRows = (sug && sug.suggestions ? sug.suggestions : []).map((s) => h('tr', null,
      h('td', null, h('strong', null, s.title), h('div', { class: 'hint block mono' }, `${s.eventType} \u00B7 ${s.paypalEventId || s.eventId}`)),
      h('td', null, h('span', { class: `badge ${s.priority === 'high' ? 'bad' : s.priority === 'medium' ? 'warn' : 'idle'}` }, pretty(s.priority))),
      h('td', { class: 'wrap' }, s.rationale,
        s.basedOn && s.basedOn.length ? h('ul', { class: 'plain evidence' }, s.basedOn.map((b) => h('li', null, h('span', { class: 'tag' }, 'Evidence'), ' ', b))) : null),
      h('td', null, (() => {
        const b = h('button', { class: 'btn', type: 'button', onclick: async () => {
          b.disabled = true; b.textContent = 'Running\u2026';
          state.aiPlanError = null;
          try {
            const body = { kind: s.scenario.kind, ...(s.scenario.params || {}), idempotencyKey: newKey() };
            const data = await api('POST', `/api/projects/${p.id}/events/${s.eventId}/scenarios`, body);
            state.runDetail = await api('GET', `/api/projects/${p.id}/scenario-runs/${data.run.id}`);
            await loadEventData(p.id);
          } catch (ex) {
            if (ex.status === 401) return showLogin('Your session ended. Sign in again.');
            state.aiPlanError = ex;
          }
          renderMain();
        } }, 'Run test');
        return b;
      })())));

    return h('section', { class: 'panel' },
      h('h2', { class: 'section' }, 'AI Test Engineer'),
      h('p', { class: 'hint-text' }, 'Plans structured webhook reliability tests from plain English, explains failures using only stored execution traces, and recommends next tests from observed evidence. It cannot fabricate events, invent passing results, access PayPal secrets, or override deterministic checks.'),
      planForm,
      quickBtns,
      state.aiPlanError ? errorBox(state.aiPlanError) : null,
      state.aiSelectedPlan ? renderPlanSpec(p, state.aiSelectedPlan) : null,
      h('h2', { class: 'section spaced' }, 'Evidence-based failure analysis'),
      finishedRuns.length === 0
        ? h('p', { class: 'empty' }, 'No finished scenario runs yet. Run a scenario above, then ask the AI Test Engineer to explain the execution trace.')
        : h('div', { class: 'row-form' },
          h('label', { class: 'field grow', for: 'aiAnalyzeRunSelect' }, h('span', { class: 'label' }, 'Select a completed or failed scenario run'), runSelect),
          h('div', { class: 'field' }, h('span', { class: 'label' }, '\u00A0'), analyzeRunBtn)),
      state.aiAnalysisError ? errorBox(state.aiAnalysisError) : null,
      activeAnalysis ? aiAnalysisView(activeAnalysis) : null,
      h('h2', { class: 'section spaced' }, 'Recommended additional tests (from stored evidence)'),
      sug ? h('p', { class: 'hint-text' }, sug.summary) : null,
      !sug || sug.insufficientEvidence || !sug.suggestions.length
        ? h('p', { class: 'empty' }, sug && sug.insufficientEvidence ? 'Receive at least one PayPal-verified webhook event to unlock integration-specific test recommendations.' : 'All standard fault scenarios have been exercised on the currently stored verified events.')
        : h('div', { class: 'table-wrap' }, h('table', { class: 'checks' },
          h('thead', null, h('tr', null, ['Recommended test', 'Priority', 'Why it matters (based on stored evidence)', ''].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, suggestionRows))));
  }

  // ---- start ------------------------------------------------------------
  (async function boot() {
    try {
      const me = await api('GET', '/api/auth/me');
      if (me.authenticated) await showApp(); else showLogin();
    } catch (ex) {
      showLogin(ex.message);
    }
  })();
})();
