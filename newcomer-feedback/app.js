/* Maestro newcomer-flows prototype — scene engine (vanilla JS, no deps) */
'use strict';

/* ---------------- icons (inline SVG, stroke style to match lucide) ---------------- */
const I = (d, extra) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra || ''}>${d}</svg>`;
const ICONS = {
  wand: I('<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M15 9h0M17.8 6.2L19 5M12.2 6.2L11 5"/><path d="M3 21l9-9"/>'),
  menu: I('<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>'),
  branch: I('<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
  plus: I('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  bell: I('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  bot: I('<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/>'),
  search: I('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  panelLeft: I('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>'),
  type: I('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>'),
  monitor: I('<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'),
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  filter: I('<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>'),
  msgPlus: I('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'),
};

/* ---------------- shared partials ---------------- */
function titlebar() {
  return `<div class="titlebar">
    <div class="traffic" aria-hidden="true"><span class="r"></span><span class="y"></span><span class="g"></span></div>
    <div class="titlebar-title">Maestro — Agent Orchestration Command Center</div>
  </div>`;
}

function sidebar(opts) {
  const o = Object.assign({ collapsed: false, busy: true, toggle: false }, opts);
  if (o.collapsed) {
    return `<aside class="sidebar collapsed" aria-label="Agent sidebar (collapsed)">
      <div class="rail">
        <button class="icon-btn" title="Menu" aria-label="Menu">${ICONS.menu}</button>
        <div class="rail-sep"></div>
        <div class="rail-avatar" title="Review Agent — busy">RA<span class="dot ${o.busy ? 'busy' : 'idle'}"></span></div>
        <div class="rail-avatar" title="Docs Agent — busy">DA<span class="dot ${o.busy ? 'busy' : 'idle'}"></span></div>
        <div class="rail-avatar" title="Build Agent — idle">BA<span class="dot idle"></span></div>
        <div class="rail-sep"></div>
        <button class="rail-new-agent" id="btn-new-agent-rail" title="New Agent (⌘N)" aria-label="New Agent">+</button>
      </div>
      <div class="sidebar-footer">
        ${o.toggle ? `<button class="icon-btn" id="btn-sidebar-toggle" title="Expand Sidebar (Alt+Ctrl+←)" aria-label="Expand Sidebar">${ICONS.panelLeft}</button>` : ''}
      </div>
    </aside>`;
  }
  return `<aside class="sidebar" aria-label="Agent sidebar">
    <div class="sidebar-header">
      <div class="sidebar-brand"><span style="color:var(--accent)">${ICONS.wand.replace('<svg', '<svg width="18" height="18"')}</span>MAESTRO <span class="badge-offline">OFFLINE</span></div>
      <button class="icon-btn" title="Menu" aria-label="Menu">${ICONS.menu}</button>
    </div>
    <div class="sidebar-list">
      <button class="agent-card active">
        <div class="agent-card-top"><span class="agent-name">Review Agent</span><span class="dot ${o.busy ? 'busy' : 'idle'}"></span></div>
        <div class="agent-sub"><span class="badge-git">GIT</span> claude-code</div>
      </button>
      <button class="agent-card">
        <div class="agent-card-top"><span class="agent-name">Docs Agent</span><span class="dot ${o.busy ? 'busy' : 'idle'}"></span></div>
        <div class="agent-sub"><span class="badge-git">GIT</span> claude-code</div>
      </button>
      <button class="agent-card">
        <div class="agent-card-top"><span class="agent-name">Build Agent</span><span class="dot idle"></span></div>
        <div class="agent-sub">codex</div>
      </button>
      <div class="sidebar-create-row" style="padding:10px 4px 4px">
        <button class="pill-btn" id="btn-new-agent" title="New Agent (⌘N)">${ICONS.plus.replace('<svg', '<svg width="11" height="11"')} New Agent</button>
        <button class="pill-btn secondary" title="Create new group">${ICONS.plus.replace('<svg', '<svg width="11" height="11"')} New Group</button>
      </div>
    </div>
    <div class="sidebar-footer">
      ${o.toggle ? `<button class="icon-btn" id="btn-sidebar-toggle" title="Collapse Sidebar (Alt+Ctrl+←)" aria-label="Collapse Sidebar">${ICONS.panelLeft}</button>` : `<button class="icon-btn" title="Collapse Sidebar (Alt+Ctrl+←)" aria-label="Collapse Sidebar">${ICONS.panelLeft}</button>`}
      <div class="spacer"></div>
      <button class="footer-label-btn">${ICONS.msgPlus.replace('<svg', '<svg width="13" height="13"')} Feedback</button>
      <button class="icon-btn" title="Filter unread agents (Alt+U)" aria-label="Filter unread agents">${ICONS.filter}</button>
    </div>
  </aside>`;
}

function sessionHeader(opts) {
  const o = Object.assign({ busy: true }, opts);
  return `<div class="session-header">
    <div class="session-crumb">
      <button class="crumb-name" id="btn-crumb" title="Show activity for Review Agent" aria-haspopup="dialog">Review Agent <span class="dot ${o.busy ? 'busy' : 'idle'}"></span></button>
      <button class="branch-chip">${ICONS.branch.replace('<svg', '<svg width="11" height="11"')} review/newcomer-feedback-1225-1231</button>
      <button class="branch-chip">+0 −0 ~0</button>
    </div>
    <div class="session-header-right">
      <span>$0.83</span>
      <button class="ctx-chip" title="Open context timeline">21%</button>
      <button class="icon-btn" title="Memory Viewer (Ctrl+Shift+M)" aria-label="Memory Viewer">${ICONS.bot}</button>
      <button class="icon-btn" title="Agent Sessions (Ctrl+Shift+L)" aria-label="Agent Sessions">${ICONS.monitor}</button>
    </div>
  </div>`;
}

function tabbar() {
  return `<div class="tabbar">
    <button class="icon-btn" title="Search…" aria-label="Search tabs">${ICONS.search}</button>
    <button class="tab active"><span class="tab-num">0</span> refactor plan</button>
    <button class="tab"><span class="tab-num">1</span> tests</button>
    <button class="tab tab-plus icon-btn" title="New tab…" aria-label="New tab">${ICONS.plus}</button>
    <div class="spacer"></div>
  </div>`;
}

function transcript() {
  return `<div class="transcript">
    <div class="msg msg-user"><div class="msg-meta">12:51 AM</div>
      <div class="msg-bubble"><p>Run the renderer type checks, then summarize any failures in the settings store.</p></div></div>
    <div class="msg msg-agent"><div class="msg-meta">12:51 AM · Review Agent</div>
      <div class="msg-bubble">
        <p>Running the type checks now — I'll start with the renderer project.</p>
        <span class="tool-chip">▸ Bash — bun run typecheck:renderer</span>
      </div></div>
  </div>`;
}

function composer(opts) {
  const o = Object.assign({ pill: false, popover: false }, opts);
  return `<div class="composer-zone">
    ${o.pill ? activityPill(o.popover) : ''}
    <div class="composer">
      <div class="composer-input">Talking to Review Agent powered by Claude Code</div>
      <div class="composer-row">
        <div class="composer-left">
          <button class="chip-btn" title="Open Prompt Composer (Ctrl+Shift+P)">✍ Compose</button>
          <button class="chip-btn">🖼 Attach</button>
          <button class="chip-btn">⛭ default</button>
        </div>
        <div class="composer-right">
          <button class="chip-btn">History</button>
          <button class="chip-btn">Full Access</button>
          <button class="chip-btn on">Thinking</button>
          <button class="chip-btn">Enter ⏎</button>
          <button class="icon-btn" title="Notification Settings" aria-label="Notification Settings">${ICONS.bell}</button>
          <button class="send-btn" title="Send message" aria-label="Send message">↑</button>
        </div>
      </div>
    </div>
  </div>`;
}

/* ---------------- #1231 pill + popover ---------------- */
function activityPill(popoverOpen) {
  return `<div class="activity-pill-wrap">
    <div class="activity-pill">
      <button class="pill-main" id="btn-pill" aria-expanded="${popoverOpen ? 'true' : 'false'}" aria-label="Agent activity: running Bash, 12 seconds elapsed">
        <span class="dot busy"></span>
        <span class="pill-label">Bash: bun run typecheck:renderer</span>
        <span class="pill-time">12s</span>
        <span class="pill-tokens">1.2k tok</span>
        <span class="pill-more">+2</span>
      </button>
      <button class="pill-stop" aria-label="Stop Review Agent">${ICONS.stop.replace('<svg', '<svg width="10" height="10"')} Stop</button>
    </div>
    ${popoverOpen ? activityPopover() : ''}
  </div>`;
}

function activityPopover() {
  return `<div class="activity-popover" role="dialog" aria-label="Agent Activity">
    <div class="popover-agg">2 agents busy · 1 shell command running · 0 errors</div>
    <div class="popover-rows">
      <button class="popover-row"><span class="dot busy"></span><span class="row-name">Review Agent / refactor plan</span><span class="row-label">Bash: bun run typecheck:renderer</span><span class="row-time">12s</span></button>
      <button class="popover-row"><span class="dot busy"></span><span class="row-name">Docs Agent / api notes</span><span class="row-label">Thinking…</span><span class="row-time">41s</span></button>
      <button class="popover-row"><span class="dot quiet"></span><span class="row-name">Build Agent / release</span><span class="row-label">No output for 45s</span><span class="row-time">2m 10s</span></button>
    </div>
    <div class="popover-footer"><button class="popover-open-btn" id="btn-open-inspector">Open Inspector ⏎</button></div>
  </div>`;
}

/* ---------------- #1231 inspector ---------------- */
function inspectorEvents(rows) {
  return rows.map((r, i) => `<div class="event-row ${r.note ? 'event-note' : ''}">
    <div class="event-line">
      <span class="event-ts">${r.ts}</span>
      <span class="event-label">${r.label}</span>
      ${r.detail ? `<button class="event-expand" data-ev="${i}" aria-expanded="false">Show detail ▸</button>` : ''}
    </div>
    ${r.detail ? `<div class="event-detail" data-detail="${i}" hidden>${r.detail}</div>` : ''}
  </div>`).join('');
}

const INSPECTOR_ROWS = [
  { ts: '12:52:14', label: 'Streaming response <span class="muted">— 1.2k tokens received</span>' },
  { ts: '12:52:11', label: 'Bash finished <span class="muted">— bun run typecheck:renderer (10.2s, exit 0)</span>',
    detail: '<span class="k">command</span>  bun run typecheck:renderer\n<span class="k">cwd</span>      C:/Users/Administrator/Software/Maestro\n<span class="k">exit</span>     0 · <span class="k">duration</span> 10.2s · <span class="k">pid</span> 41288\n<span class="k">output</span>   $ tsc -p src/renderer --noEmit … 0 errors' },
  { ts: '12:52:01', label: 'Bash started <span class="muted">— bun run typecheck:renderer</span>',
    detail: '<span class="k">command</span>  bun run typecheck:renderer\n<span class="k">pid</span>      41288 · <span class="k">cwd</span> C:/Users/Administrator/Software/Maestro' },
  { ts: '12:51:59', label: 'Read <span class="muted">— src/renderer/stores/settingsStore.ts (lines 315–360)</span>',
    detail: '<span class="k">tool</span>     Read\n<span class="k">target</span>   src/renderer/stores/settingsStore.ts:315-360\n<span class="k">preview</span>  fontSize: number; activeThemeId: ThemeId; …' },
  { ts: '12:51:58', label: 'Thinking started' },
  { ts: '12:51:26', label: 'No output received for 45 seconds. The agent may be working silently, or the connection may be stuck. You can keep waiting or press Stop.', note: true },
  { ts: '12:50:41', label: 'Request sent. Waiting for the first response from Claude Code. Maestro can\u2019t see provider status — only what arrives.', note: true },
];

function inspector(opts) {
  const o = Object.assign({ rows: INSPECTOR_ROWS, title: 'Agent activity — Review Agent / refactor plan', chip: 'tool-running', meta: '12s · 1.2k tokens', close: true }, opts);
  return `<div class="inspector" role="region" aria-label="Agent activity">
    <div class="inspector-header">
      <span class="state-chip"><span class="dot busy"></span> ${o.chip}</span>
      <span>${o.title}</span>
      <span class="meta">${o.meta}</span>
      <div class="spacer"></div>
      <button class="pill-stop">${ICONS.stop.replace('<svg', '<svg width="10" height="10"')} Stop</button>
      <button class="link-btn">Process Monitor ↗</button>
      ${o.close ? '<button class="icon-btn" title="Close (Cmd+Shift+A)" aria-label="Close inspector">✕</button>' : ''}
    </div>
    <div class="inspector-events">${inspectorEvents(o.rows)}</div>
  </div>`;
}

/* ---------------- app frame composition ---------------- */
function appShell(inner, opts) {
  const o = Object.assign({ collapsed: false, busy: true, toggle: false, menubar: '' }, opts);
  return `${o.menubar}${titlebar()}
  <div class="app-body">
    ${sidebar(o)}
    <div class="main-panel">${inner}</div>
  </div>`;
}

/* ---------------- #1228 fonts scene state ---------------- */
const fontState = {
  detecting: true,
  installed: ['Cascadia Code', 'Cascadia Mono', 'Consolas', 'Courier New', 'JetBrainsMono Nerd Font', 'Lucida Console', 'MesloLGS NF', 'Roboto Mono', 'Segoe UI Mono'],
  common: ['Roboto Mono', 'JetBrains Mono', 'Fira Code', 'Monaco', 'Menlo', 'Consolas', 'Courier New', 'SF Mono', 'Cascadia Code', 'Source Code Pro'],
  custom: ['JetBrainsMono NF'],
  interfaceFont: 'Roboto Mono',
  terminalFont: '__same__',
  prevTerminalFont: null,
  toastTimer: null,
};

function fontOptions(selected, includeSame) {
  const notDetected = (f) => fontState.detecting ? '' : (fontState.installed.some(s => s.toLowerCase().replace(/[\s-]/g, '').includes(f.toLowerCase().replace(/[\s-]/g, ''))) ? '' : ' (not detected)');
  let html = '';
  if (includeSame) html += `<option value="__same__" ${selected === '__same__' ? 'selected' : ''}>Same as interface font</option>`;
  html += `<optgroup label="Common Monospace Fonts">` + fontState.common.map(f =>
    `<option value="${f}" ${selected === f ? 'selected' : ''}>${f}${notDetected(f)}</option>`).join('') + `</optgroup>`;
  if (!fontState.detecting) {
    html += `<optgroup label="Installed Fonts">` + fontState.installed.map(f =>
      `<option value="${f}" ${selected === f ? 'selected' : ''}>${f}</option>`).join('') + `</optgroup>`;
  }
  if (fontState.custom.length) {
    html += `<optgroup label="Custom Fonts">` + fontState.custom.map(f =>
      `<option value="${f}" ${selected === f ? 'selected' : ''}>${f}</option>`).join('') + `</optgroup>`;
  }
  return html;
}

function fontsScene() {
  const termFontCss = fontState.terminalFont === '__same__' ? fontState.interfaceFont : fontState.terminalFont;
  const inner = `${sessionHeader({ busy: false })}${tabbar()}
    <div class="transcript" aria-hidden="true">${''}</div>
    ${composer({})}`;
  const modal = `<div class="modal-scrim">
    <div class="settings-modal" role="dialog" aria-label="Settings">
      <div class="settings-nav">
        <div class="settings-nav-title">Settings</div>
        <button class="nav-item">General</button>
        <button class="nav-item active">Display</button>
        <button class="nav-item">Shortcuts</button>
        <button class="nav-item">Notifications</button>
        <button class="nav-item">Agents</button>
        <button class="nav-item">Advanced</button>
      </div>
      <div class="settings-body">
        <div class="settings-section">
          <h3 class="settings-h">${ICONS.type} Interface Font</h3>
          <div class="field-row">
            <select class="select" id="sel-interface-font" aria-label="Interface font">${fontOptions(fontState.interfaceFont, false)}</select>
            <button class="reset-link" id="reset-interface">Reset to default</button>
          </div>
          <div class="preview-box"><div class="preview-line" id="prev-interface" style="font-family:'${fontState.interfaceFont}', monospace">The quick brown fox · 0O o · Il1 |</div>
          <div class="preview-caption">Applies to the app interface. Changes apply immediately.</div></div>
        </div>
        <div class="settings-section">
          <h3 class="settings-h">${ICONS.type} Terminal Font</h3>
          <div class="field-row">
            <select class="select" id="sel-terminal-font" aria-label="Terminal font">${fontOptions(fontState.terminalFont, true)}</select>
            <button class="reset-link" id="reset-terminal">Reset to default</button>
          </div>
          <div class="detect-note" id="detect-note" role="status">${fontState.detecting ? '<span class="spinner" aria-hidden="true"></span> Detecting installed fonts…' : `${fontState.installed.length} installed fonts detected`}</div>
          <div class="preview-box"><div class="preview-line" id="prev-terminal" style="font-family:'${termFontCss}', monospace">❯ ✓ ✗ ± │├─ ⭠ &#xe0b0; &#xf07b; &#xf418;</div>
          <div class="preview-caption">Rendered in the selected terminal font — exactly what your shell will show.</div></div>
          <div class="glyph-note"><span class="n-ico">⚠</span><span>If any symbols above appear as boxes, your prompt theme needs a font with those glyphs — e.g. a Nerd Font. <a href="#" onclick="return false">Get a Nerd Font ↗</a></span></div>
          <div class="custom-font-row">
            <input class="text-input" id="custom-font-input" placeholder="Add custom font name..." aria-label="Add custom font name">
            <button class="add-btn" id="btn-add-font">Add</button>
          </div>
          <div class="font-chips" id="font-chips">${fontState.custom.map(f => `<span class="font-chip">${f} <button data-rm="${f}" aria-label="Remove ${f}">×</button></span>`).join('')}</div>
        </div>
      </div>
    </div>
  </div>
  <div class="toast" id="font-toast" hidden><span id="toast-msg"></span><button class="link-btn" id="btn-revert">Revert</button></div>`;
  return appShell(inner + modal, { busy: false });
}

function wireFontsScene() {
  const frame = document.getElementById('app-frame');
  // async detection that NEVER unmounts the select — options update in place
  if (fontState.detecting) {
    setTimeout(() => {
      if (currentScene !== 'fonts') return;
      fontState.detecting = false;
      const selT = document.getElementById('sel-terminal-font');
      const selI = document.getElementById('sel-interface-font');
      if (selT) selT.innerHTML = fontOptions(fontState.terminalFont, true);
      if (selI) selI.innerHTML = fontOptions(fontState.interfaceFont, false);
      const note = document.getElementById('detect-note');
      if (note) note.textContent = `${fontState.installed.length} installed fonts detected`;
    }, 1400);
  }
  const showToast = (msg) => {
    const toast = document.getElementById('font-toast');
    document.getElementById('toast-msg').textContent = msg;
    toast.hidden = false;
    clearTimeout(fontState.toastTimer);
    fontState.toastTimer = setTimeout(() => { toast.hidden = true; }, 10000);
  };
  frame.querySelector('#sel-terminal-font').addEventListener('change', (e) => {
    fontState.prevTerminalFont = fontState.terminalFont;
    fontState.terminalFont = e.target.value;
    const css = fontState.terminalFont === '__same__' ? fontState.interfaceFont : fontState.terminalFont;
    document.getElementById('prev-terminal').style.fontFamily = `'${css}', monospace`;
    showToast('Terminal font changed —');
  });
  frame.querySelector('#sel-interface-font').addEventListener('change', (e) => {
    fontState.interfaceFont = e.target.value;
    document.getElementById('prev-interface').style.fontFamily = `'${fontState.interfaceFont}', monospace`;
    if (fontState.terminalFont === '__same__') document.getElementById('prev-terminal').style.fontFamily = `'${fontState.interfaceFont}', monospace`;
  });
  frame.querySelector('#btn-revert').addEventListener('click', () => {
    if (fontState.prevTerminalFont !== null) {
      fontState.terminalFont = fontState.prevTerminalFont;
      frame.querySelector('#sel-terminal-font').value = fontState.terminalFont;
      const css = fontState.terminalFont === '__same__' ? fontState.interfaceFont : fontState.terminalFont;
      document.getElementById('prev-terminal').style.fontFamily = `'${css}', monospace`;
    }
    document.getElementById('font-toast').hidden = true;
  });
  frame.querySelector('#reset-terminal').addEventListener('click', () => {
    fontState.prevTerminalFont = fontState.terminalFont;
    fontState.terminalFont = '__same__';
    frame.querySelector('#sel-terminal-font').value = '__same__';
    document.getElementById('prev-terminal').style.fontFamily = `'${fontState.interfaceFont}', monospace`;
    showToast('Terminal font reset to “Same as interface font” —');
  });
  frame.querySelector('#reset-interface').addEventListener('click', () => {
    fontState.interfaceFont = 'Roboto Mono';
    frame.querySelector('#sel-interface-font').value = 'Roboto Mono';
    document.getElementById('prev-interface').style.fontFamily = `'Roboto Mono', monospace`;
  });
  frame.querySelector('#btn-add-font').addEventListener('click', () => {
    const inp = document.getElementById('custom-font-input');
    const v = inp.value.trim();
    if (v && !fontState.custom.includes(v)) {
      fontState.custom.push(v);
      frame.querySelector('#sel-terminal-font').innerHTML = fontOptions(fontState.terminalFont, true);
      frame.querySelector('#sel-interface-font').innerHTML = fontOptions(fontState.interfaceFont, false);
      document.getElementById('font-chips').innerHTML = fontState.custom.map(f => `<span class="font-chip">${f} <button data-rm="${f}" aria-label="Remove ${f}">×</button></span>`).join('');
      wireChipRemovals();
      inp.value = '';
    }
  });
  frame.querySelector('#custom-font-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') frame.querySelector('#btn-add-font').click();
  });
  function wireChipRemovals() {
    frame.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => {
      const f = b.getAttribute('data-rm');
      fontState.custom = fontState.custom.filter(x => x !== f);
      if (fontState.terminalFont === f) {
        fontState.prevTerminalFont = f;
        fontState.terminalFont = '__same__';
        document.getElementById('prev-terminal').style.fontFamily = `'${fontState.interfaceFont}', monospace`;
        showToast('Terminal font reset to “Same as interface font” —');
      }
      frame.querySelector('#sel-terminal-font').innerHTML = fontOptions(fontState.terminalFont, true);
      frame.querySelector('#sel-interface-font').innerHTML = fontOptions(fontState.interfaceFont, false);
      document.getElementById('font-chips').innerHTML = fontState.custom.map(x => `<span class="font-chip">${x} <button data-rm="${x}" aria-label="Remove ${x}">×</button></span>`).join('');
      wireChipRemovals();
    }));
  }
  wireChipRemovals();
}

/* ---------------- #1227 menus + cmd+k ---------------- */
const COMMANDS = [
  { label: 'Switch AI/Shell Mode', sub: 'Type shell commands in the current tab', key: '⌘J', kw: 'terminal shell console command line mode' },
  { label: 'New Terminal', sub: 'Open a new terminal tab in the active agent', key: '⌘⇧J', kw: 'terminal shell console tty' },
  { label: 'Clear Terminal', sub: 'Clear the active terminal tab', key: '', kw: 'terminal clear reset' },
  { label: 'New AI Chat', sub: 'Open a new AI chat tab in the active agent', key: '⌘T', kw: 'tab chat ai' },
  { label: 'New Agent', sub: 'Create a new agent', key: '⌘N', kw: 'agent create session add' },
  { label: 'Show Agent Activity', sub: 'What every agent is doing right now', key: '⌘⇧A', kw: 'status busy running background processes activity' },
  { label: 'Change Fonts…', sub: 'Interface and terminal fonts', key: '', kw: 'font typeface terminal font glyph nerd settings' },
];

function cmdkRows(q) {
  const query = q.trim().toLowerCase();
  const hits = COMMANDS.filter(c => !query || c.label.toLowerCase().includes(query) || c.sub.toLowerCase().includes(query) || c.kw.includes(query));
  if (!hits.length) return `<div class="cmdk-empty">No commands match “${q}”. Try “terminal”, “font”, or “agent” — or browse Keyboard Shortcuts.</div>`;
  return hits.map((c, i) => `<button class="cmdk-row ${i === 0 ? 'sel' : ''}">
    <span class="cmdk-num">${i + 1}</span>
    <span class="cmdk-labels"><div class="cmdk-label">${c.label}</div><div class="cmdk-sub">${c.sub}</div></span>
    ${c.key ? `<span class="cmdk-key">${c.key}</span>` : ''}
  </button>`).join('');
}

function menusScene() {
  const menubar = `<div class="macos-menubar" aria-label="macOS menu bar (simulated)">
    <span class="apple"></span>
    <button class="menu-title" style="font-weight:700">Maestro</button>
    <button class="menu-title">File</button>
    <button class="menu-title">Edit</button>
    <button class="menu-title">View</button>
    <button class="menu-title open" aria-expanded="true">Terminal</button>
    <button class="menu-title">Window</button>
    <button class="menu-title">Help</button>
    <div class="menu-dropdown" style="left:300px" role="menu" aria-label="Terminal menu">
      <button class="menu-row" role="menuitem"><span>Switch AI/Shell Mode</span><span class="menu-key">⌘J</span></button>
      <button class="menu-row disabled" role="menuitem" aria-disabled="true" title="The active tab isn't a terminal"><span>Clear Terminal</span><span class="menu-key"></span></button>
      <div class="menu-sep"></div>
      <button class="menu-row" role="menuitem"><span>New Terminal</span><span class="menu-key">⌘⇧J</span></button>
    </div>
  </div>`;
  const inner = `${sessionHeader({ busy: false })}${tabbar()}${transcript()}${composer({})}
    <div class="cmdk" role="dialog" aria-label="Quick Actions">
      <div class="cmdk-input-row">${ICONS.search.replace('<svg', '<svg width="14" height="14" style="color:var(--dim)"')}
        <input class="cmdk-input" id="cmdk-input" value="term" aria-label="Type a command or jump to agent" placeholder="Type a command or jump to agent...">
        <span class="cmdk-esc">ESC</span>
      </div>
      <div class="cmdk-list" id="cmdk-list">${cmdkRows('term')}</div>
      <div class="cmdk-footer"><button class="link-btn">Keyboard Shortcuts →</button></div>
    </div>`;
  return appShell(inner, { busy: false, menubar });
}

/* ---------------- #1225 wizard scenes ---------------- */
function wizardSteps(current) {
  const steps = ['Agent', 'Project', 'Scan', 'Path', 'Review'];
  return `<nav class="wizard-steps" aria-label="Setup steps">` + steps.map((s, i) => {
    const n = i + 1;
    const cls = n < current ? 'done' : (n === current ? 'current' : '');
    return `${i ? '<span class="wstep-sep"></span>' : ''}<span class="wstep ${cls}" ${n === current ? 'aria-current="step"' : ''}><span class="n">${n < current ? '✓' : n}</span>${s}</span>`;
  }).join('') + `</nav>`;
}

const AGENT_NAMES = ['Juno', 'Miles', 'Ada', 'Otis', 'Wren', 'Kai', 'Nova', 'Remy'];
let nameIdx = 0;

function onboardingAgentScene() {
  const inner = `<div class="wizard">
    ${wizardSteps(1)}
    <h2 class="wizard-title">Create a Maestro Agent</h2>
    <p class="wizard-sub">An agent is an <strong>AI coworker attached to one project folder</strong>. Its name is just a label in your sidebar — pick anything.</p>
    <div class="name-row">
      <input class="name-input" id="agent-name" value="${AGENT_NAMES[nameIdx]}" aria-label="Agent name">
      <button class="shuffle-btn" id="btn-shuffle" aria-label="Suggest another name" title="Suggest another name">↻</button>
      <select class="select loc-select" aria-label="Agent location"><option>This computer</option><option>SSH remote…</option></select>
    </div>
    <div class="agent-grid">
      <button class="agent-tile selected" aria-pressed="true"><span class="logo">✳</span><span class="t-name">Claude Code</span><span class="t-status">Detected</span></button>
      <button class="agent-tile"><span class="logo">◳</span><span class="t-name">Codex</span><span class="t-status">Detected</span></button>
      <button class="agent-tile"><span class="logo">✦</span><span class="t-name">Gemini CLI</span><span class="t-status miss">Not detected</span></button>
      <button class="agent-tile"><span class="logo">▣</span><span class="t-name">OpenCode</span><span class="t-status miss">Not detected</span></button>
    </div>
    <div class="model-line">Planning and chat will use <strong style="color:var(--text)">Claude Code · model: provider default</strong>. <button class="link-btn">Change</button></div>
    <div class="wizard-footer">
      <button class="w-btn" data-goto="">Cancel</button>
      <button class="w-btn primary" data-goto="onboarding-scan">Next — Choose project</button>
    </div>
  </div>`;
  return `${titlebar()}${inner}`;
}

function onboardingScanScene() {
  const inner = `<div class="wizard">
    ${wizardSteps(3)}
    <h2 class="wizard-title">Here’s what I found in Maestro/</h2>
    <p class="wizard-sub">Scanned locally in 1.4s — nothing is sent until you continue.</p>
    <div class="scan-panel">
      <div class="findings">
        <div class="finding"><span class="f-ico ok">✓</span><span>Node + Electron app <span class="f-cite">— package.json (“maestro”, electron 31, bun)</span></span></div>
        <div class="finding"><span class="f-ico ok">✓</span><span>README.md found <span class="f-cite">— 218 lines, project overview + build steps</span></span></div>
        <div class="finding"><span class="f-ico ok">✓</span><span>Git repository <span class="f-cite">— origin github.com/maestro-org/maestro, branch main</span></span></div>
        <div class="finding"><span class="f-ico ok">✓</span><span>CI configured <span class="f-cite">— .github/workflows (3 workflows)</span></span></div>
        <div class="finding"><span class="f-ico warn">⚠</span><span>Existing planning docs <span class="f-cite">— CLAUDE.md, docs/plans/</span></span></div>
      </div>
      <div class="scan-callout">This project already has planning docs (CLAUDE.md, docs/plans/). A Playbook may duplicate them — you can choose your path on the next step.</div>
      <div class="refine-row">
        <input class="text-input" placeholder="Anything to add or correct? (optional)" aria-label="Anything to add or correct (optional)">
        <button class="add-btn" title="Send">→</button>
      </div>
      <p class="send-disclosure">When you continue, Maestro sends your message, the scan summary above, and the contents of files the agent chooses to read to Claude Code.</p>
    </div>
    <div class="wizard-footer">
      <button class="w-btn" data-goto="onboarding-agent">Back</button>
      <button class="w-btn primary" data-goto="onboarding-path">Next — Choose your path</button>
    </div>
  </div>`;
  return `${titlebar()}${inner}`;
}

let pathChoice = 'agent-only'; // Agent-only is ALWAYS preselected (delta D4)

function onboardingPathScene() {
  const agentSel = pathChoice === 'agent-only';
  const inner = `<div class="wizard">
    ${wizardSteps(4)}
    <h2 class="wizard-title">How do you want to start?</h2>
    <p class="wizard-sub">You can do either now and the other anytime later.</p>
    <div class="path-cards" role="radiogroup" aria-label="Choose your path">
      <button class="path-card ${agentSel ? 'selected' : ''}" id="card-agent" role="radio" aria-checked="${agentSel}">
        <span class="radio"></span>
        <span>
          <h4>Just create the agent</h4>
          <p>Start chatting and working immediately. You can create a Playbook anytime later from the Menu.</p>
        </span>
      </button>
      <button class="path-card ${agentSel ? '' : 'selected'}" id="card-playbook" role="radio" aria-checked="${!agentSel}">
        <span class="radio"></span>
        <span style="flex:1">
          <h4>Create a Playbook</h4>
          <p>A Playbook is a set of markdown planning documents (phases and tasks) Maestro can execute step-by-step with your approval.</p>
          <span class="disclosure"><dl>
            <dt>Model</dt><dd>Claude Code · provider default</dd>
            <dt>Destination</dt><dd>Maestro/.maestro/playbooks/</dd>
            <dt>Sends</dt><dd>The scan summary and files the agent reads to Claude Code</dd>
            <dt>Scope</dt><dd>Typically 3–6 documents · usually a few minutes · uses tokens on your account</dd>
          </dl></span>
        </span>
      </button>
    </div>
    <p class="path-footer-note">Nothing is generated and nothing is sent until you choose <strong style="color:var(--text)">Generate Playbook</strong>.</p>
    <div class="wizard-footer">
      <button class="w-btn" data-goto="onboarding-scan">Back</button>
      ${agentSel
        ? '<button class="w-btn primary" data-goto="">Create Agent</button>'
        : '<button class="w-btn success" data-goto="onboarding-generate">Generate Playbook</button>'}
    </div>
  </div>`;
  return `${titlebar()}${inner}`;
}

const GEN_ROWS = [
  { ts: '01:04:12', label: 'Writing <span class="muted">— .maestro/playbooks/phase-2-implementation.md</span>' },
  { ts: '01:03:58', label: 'Streaming response <span class="muted">— 6.4k tokens received</span>' },
  { ts: '01:03:21', label: 'Read <span class="muted">— README.md (218 lines)</span>',
    detail: '<span class="k">tool</span>     Read\n<span class="k">target</span>   README.md\n<span class="k">preview</span>  # Maestro — Agent Orchestration Command Center …' },
  { ts: '01:03:19', label: 'Read <span class="muted">— package.json</span>' },
  { ts: '01:03:12', label: 'Playbook generation started <span class="muted">— scan summary sent to Claude Code (provider default model)</span>' },
];

function onboardingGenerateScene() {
  const inner = `<div class="gen-layout">
    <div class="gen-head">
      ${wizardSteps(5)}
      <h2>Creating your Playbook</h2>
      <p>Writing planning documents to Maestro/.maestro/playbooks/ — you'll review everything before anything runs.</p>
    </div>
    <div class="gen-cols">
      <div class="created-files">
        <div class="cf-title">Created files</div>
        <div class="cf-row"><span class="f-ico ok">✓</span> overview.md</div>
        <div class="cf-row"><span class="f-ico ok">✓</span> phase-1-foundations.md</div>
        <div class="cf-row"><span class="dot busy"></span> phase-2-implementation.md</div>
        <div class="cf-row"><span class="f-pending">·</span> phase-3-verification.md</div>
      </div>
      <div class="gen-inspector">
        ${inspector({ rows: GEN_ROWS, title: 'Agent activity — Playbook generation', chip: 'tool-running', meta: '58s · 6.4k tokens', close: false })}
      </div>
    </div>
    <div class="review-footer">
      <span class="note">When generation finishes you’ll review each document. Auto Run default:</span>
      <button class="w-btn primary">Don’t start Auto Run</button>
      <button class="w-btn">Start first</button>
      <button class="w-btn">Execute all</button>
    </div>
  </div>`;
  return `${titlebar()}${inner}`;
}

/* ---------------- scene registry ---------------- */
let currentScene = '';
let sidebarCollapsed = false;
let popoverOpen = true;

const SCENES = {
  'activity-pill': {
    title: '#1231 · Agent Activity — pill & popover',
    hint: 'Click the pill (or the Review Agent breadcrumb) to toggle the popover · Esc closes',
    render() {
      return appShell(`${sessionHeader({})}${tabbar()}${transcript()}${composer({ pill: true, popover: popoverOpen })}`, {});
    },
    wire() {
      const toggle = () => { popoverOpen = !popoverOpen; setScene('activity-pill'); };
      const pill = document.getElementById('btn-pill');
      if (pill) pill.addEventListener('click', toggle);
      const crumb = document.getElementById('btn-crumb');
      if (crumb) crumb.addEventListener('click', toggle);
      const open = document.getElementById('btn-open-inspector');
      if (open) open.addEventListener('click', () => setScene('activity-inspector'));
    },
  },
  'activity-inspector': {
    title: '#1231 · Agent Activity — tab-scoped inspector',
    hint: 'Click “Show detail ▸” to expand an event · Process Monitor stays the deep record',
    render() {
      return appShell(`${sessionHeader({})}${tabbar()}${transcript()}${inspector({})}${composer({ pill: false })}`, {});
    },
    wire: wireExpanders,
  },
  'sidebar-new-agent': {
    title: '#1230 · New Agent — under the list, next to New Group',
    hint: 'Use the collapse button (bottom-left) to toggle the collapsed rail variant',
    render() {
      return appShell(`${sessionHeader({ busy: false })}${tabbar()}${transcript()}${composer({})}`, { collapsed: sidebarCollapsed, busy: false, toggle: true });
    },
    wire() {
      const t = document.getElementById('btn-sidebar-toggle');
      if (t) t.addEventListener('click', () => { sidebarCollapsed = !sidebarCollapsed; setScene('sidebar-new-agent'); });
    },
  },
  'fonts': {
    title: '#1228 · Interface Font + Terminal Font',
    hint: 'The select never unmounts — installed fonts stream in · change the terminal font to see live preview + Revert toast',
    render: fontsScene,
    wire: wireFontsScene,
  },
  'menus-cmdk': {
    title: '#1227 · macOS menus + Cmd+K vocabulary',
    hint: 'Type in the Quick Actions box — “term” matches both terminal commands, with shortcuts · macOS menu is a mock (unverified on this host)',
    render: menusScene,
    wire() {
      const inp = document.getElementById('cmdk-input');
      if (inp) inp.addEventListener('input', () => {
        document.getElementById('cmdk-list').innerHTML = cmdkRows(inp.value);
      });
    },
  },
  'onboarding-agent': {
    title: '#1225 · First run — 1 · Agent (explained, prefilled)',
    hint: '↻ shuffles the suggested name · Next advances to Scan',
    render: onboardingAgentScene,
    wire() {
      const b = document.getElementById('btn-shuffle');
      if (b) b.addEventListener('click', () => {
        nameIdx = (nameIdx + 1) % AGENT_NAMES.length;
        document.getElementById('agent-name').value = AGENT_NAMES[nameIdx];
      });
      wireGotos();
    },
  },
  'onboarding-scan': {
    title: '#1225 · First run — 3 · Deterministic local scan',
    hint: 'Findings cite real files · local until an explicitly disclosed send',
    render: onboardingScanScene,
    wire: wireGotos,
  },
  'onboarding-path': {
    title: '#1225 · First run — 4 · Path & consent (Agent-only preselected)',
    hint: 'Select a card (click or arrow keys) — the primary button changes; Generate Playbook is the consent',
    render: onboardingPathScene,
    wire() {
      const pick = (v) => { pathChoice = v; setScene('onboarding-path'); };
      const a = document.getElementById('card-agent');
      const p = document.getElementById('card-playbook');
      if (a) a.addEventListener('click', () => pick('agent-only'));
      if (p) p.addEventListener('click', () => pick('playbook'));
      [a, p].forEach(el => el && el.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          pick(pathChoice === 'agent-only' ? 'playbook' : 'agent-only');
          document.getElementById(pathChoice === 'agent-only' ? 'card-agent' : 'card-playbook').focus();
        }
      }));
      wireGotos();
    },
  },
  'onboarding-generate': {
    title: '#1225 · First run — 5 · Generation reuses the Activity Inspector',
    hint: 'Same inspector component as #1231 · review defaults to “Don’t start Auto Run”',
    render: onboardingGenerateScene,
    wire: wireExpanders,
  },
};

function wireExpanders() {
  document.querySelectorAll('.event-expand').forEach(b => b.addEventListener('click', () => {
    const i = b.getAttribute('data-ev');
    const d = document.querySelector(`[data-detail="${i}"]`);
    const open = d.hidden;
    d.hidden = !open;
    b.setAttribute('aria-expanded', String(open));
    b.textContent = open ? 'Hide detail ▾' : 'Show detail ▸';
  }));
}

function wireGotos() {
  document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => {
    const t = b.getAttribute('data-goto');
    if (t) setScene(t);
  }));
}

function setScene(id, variant) {
  if (!SCENES[id]) return;
  if (id === 'sidebar-new-agent' && variant === 'collapsed') sidebarCollapsed = true;
  if (id === 'sidebar-new-agent' && variant === 'expanded') sidebarCollapsed = false;
  if (id === 'activity-pill' && variant === 'popover') popoverOpen = true;
  if (id === 'onboarding-path' && variant === 'playbook') pathChoice = 'playbook';
  if (id === 'onboarding-path' && variant === 'agent-only') pathChoice = 'agent-only';
  if (id === 'fonts' && variant === 'detected') fontState.detecting = false;
  currentScene = id;
  const frame = document.getElementById('app-frame');
  frame.dataset.scene = id;
  frame.innerHTML = SCENES[id].render();
  document.getElementById('scene-title').textContent = SCENES[id].title;
  document.getElementById('scene-hint').textContent = SCENES[id].hint;
  document.querySelectorAll('.nav-item[data-scene]').forEach(n =>
    n.classList.toggle('active', n.dataset.scene === id));
  if (SCENES[id].wire) SCENES[id].wire();
}
window.__setScene = setScene;

/* ---------------- gallery ---------------- */
const GALLERY = [
  { src: 'assets/01-activity-pill-popover.png', title: 'Agent Activity pill & popover', cap: '#1231 — “Unable to see what the agent is doing” / “number of background shell commands”: the pill carries the live tool label; the popover adds per-agent state and the background command count, with neutral measured silence (never “almost done”).' },
  { src: 'assets/02-activity-inspector.png', title: 'Tab-scoped Activity Inspector', cap: '#1231 — “Zoom in and see what claude code is actually doing” / “Is this thread broken?”: per-event tool/command history with on-demand detail, honest awaiting-provider copy, and a Process Monitor deep link. Breadcrumb is now a real button.' },
  { src: 'assets/03-sidebar-expanded.png', title: 'New Agent beside New Group', cap: '#1230 — “Place a New Agent button beneath the agent list next to New Group”: paired create row directly under the list; footer duplicate removed (one CTA per state).' },
  { src: 'assets/04-sidebar-collapsed.png', title: 'Collapsed rail keeps creation', cap: '#1230 — collapsed-state gap: an icon-only New Agent action stays in the rail, so creation never disappears with the sidebar.' },
  { src: 'assets/05-fonts-settings.png', title: 'Interface Font + Terminal Font', cap: '#1228 — “Unable to change terminal font independently” / “UI blinks and nothing happens”: separate settings, a select that never unmounts while fonts are detected, glyph preview in the actual font, and generic Nerd Font guidance (no fabricated coverage counts).' },
  { src: 'assets/06-menus-cmdk.png', title: 'Terminal menu + Cmd+K “term”', cap: '#1227 — “menus are missing a LOT” / “cmd+K term shows no shortcut”: registry-driven Terminal menu with accelerators, and both terminal commands matching “term” with visible shortcuts. macOS rendering is mocked (unverified on this host).' },
  { src: 'assets/07-onboarding-agent.png', title: 'Onboarding — Agent step', cap: '#1225 — “Why do I have to create an agent name? What is an agent?”: the concept is explained where it’s asked, the name is prefilled with a shuffle, and the provider/model is disclosed up front (provider default — never fabricated).' },
  { src: 'assets/08-onboarding-scan.png', title: 'Onboarding — deterministic scan', cap: '#1225 — “Why am I asked to describe my project? Info is in readme/docs/code”: a bounded local scan with per-finding citations replaces the cold description prompt; copy states it’s local until an explicitly disclosed send.' },
  { src: 'assets/09-onboarding-path.png', title: 'Onboarding — Path & consent', cap: '#1225 — “Explain what a playbook is… more heads up… which model”: Agent-only is always preselected; the Playbook card discloses what/model/destination/sends/scope; Generate Playbook is the explicit consent.' },
  { src: 'assets/10-generation-review.png', title: 'Generation reuses the Inspector', cap: '#1225 + #1231 — generation transparency: the same Activity Inspector shows scan/generation events live; review defaults to “Don’t start Auto Run”.' },
];

function buildGallery() {
  document.getElementById('gallery-grid').innerHTML = GALLERY.map((g, i) =>
    `<button class="shot" data-shot="${i}" aria-label="Open full-size: ${g.title}">
      <img src="${g.src}" alt="${g.title}" loading="lazy">
      <span class="cap"><strong>${g.title}</strong>${g.cap}</span>
    </button>`).join('');
  document.querySelectorAll('.shot').forEach(s => s.addEventListener('click', () => {
    const g = GALLERY[Number(s.dataset.shot)];
    const lb = document.getElementById('lightbox');
    document.getElementById('lightbox-img').src = g.src;
    document.getElementById('lightbox-img').alt = g.title;
    document.getElementById('lightbox-cap').textContent = g.cap;
    lb.hidden = false;
    document.getElementById('lightbox-close').focus();
  }));
}

/* ---------------- global wiring ---------------- */
function fit() {
  if (window.__lockScale) {
    document.documentElement.style.setProperty('--fit-scale', '1');
    return;
  }
  const vp = document.querySelector('.frame-viewport');
  const scale = Math.min(1, (vp.clientWidth - 2) / 1440);
  document.documentElement.style.setProperty('--fit-scale', String(scale));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const lb = document.getElementById('lightbox');
    if (!lb.hidden) { lb.hidden = true; return; }
    if (currentScene === 'activity-pill' && popoverOpen) { popoverOpen = false; setScene('activity-pill'); }
  }
});

document.getElementById('lightbox-close').addEventListener('click', () => {
  document.getElementById('lightbox').hidden = true;
});
document.getElementById('lightbox').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.hidden = true;
});

document.querySelectorAll('.nav-item[data-scene]').forEach(n =>
  n.addEventListener('click', () => setScene(n.dataset.scene)));
document.querySelectorAll('.nav-item[data-jump]').forEach(n =>
  n.addEventListener('click', () => document.getElementById(n.dataset.jump).scrollIntoView({ behavior: 'smooth' })));

window.addEventListener('resize', fit);
fit();
buildGallery();
setScene('activity-pill');
