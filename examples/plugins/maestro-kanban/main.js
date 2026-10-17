/** @import { MaestroSdk } from '@maestro/plugin-sdk' */
/* global module, console, setTimeout, clearTimeout */

// Fixed column ladder for Phase 01. Placement is DERIVED from live tab status
// every refresh, never stored; Phase 02 replaces deriveColumn's policy but
// keeps its (card) -> columnId shape.
const COLUMN_IDS = ['backlog', 'in-progress', 'review', 'blocked', 'done'];

// Metadata-only topics this board needs to stay live. All ten are confirmed
// real in src/shared/plugins/events.ts; agent.statusChanged is the one whose
// field names lie (see sessionIdForEvent below).
const EVENT_TOPICS = [
	'session.created',
	'session.updated',
	'session.removed',
	'session.activated',
	'agent.statusChanged',
	'agent.completed',
	'agent.error',
	'agent.exited',
	'run.completed',
	'usage.updated',
];

// Stay well under the host's 64 KB maestro.ui.panelPost budget: the sandbox
// has no TextEncoder to measure real UTF-8 bytes, so JSON string length is
// used as a conservative proxy and the target is set with headroom.
const PANEL_BUDGET_BYTES = 56 * 1024;
const REFRESH_DEBOUNCE_MS = 150;
const PANEL_PUSH_DEBOUNCE_MS = 50;

let sdk = null;
/** @type {Map<string, object>} card key -> card */
let cards = new Map();
/** @type {Map<string, string>} sessionId -> session title */
const sessionTitle = new Map();
/** @type {Map<string, string>} sessionId -> provider/agent id */
const sessionAgentId = new Map();
/** @type {Map<string, string>} sessionId -> project path */
const sessionProjectPath = new Map();
/** @type {Map<string, number>} sessionId -> last time we saw activity */
const sessionLastActivity = new Map();
/** @type {Set<string>} sessions touched since the last tabs.list() re-read */
const dirtySessions = new Set();

let refreshTimer = null;
let panelTimer = null;

function cardKey(sessionId, tabId) {
	return sessionId + '::' + tabId;
}

/**
 * Pure: maps a card's live tab status to a column. Only two signals are
 * meaningful today - everything else (idle, unknown, undefined) is backlog.
 * Kept generic (not limited to the 'idle'/'busy' values tabs.list() actually
 * emits) so a richer status string is handled correctly if the host ever
 * reports one.
 * @param {{ status?: string }} card
 */
function deriveColumn(card) {
	const status = card && typeof card.status === 'string' ? card.status : '';
	if (status === 'error') return 'blocked';
	if (status === 'busy' || status === 'connecting') return 'in-progress';
	return 'backlog';
}

function fallbackTitle(sessionId, ordinal) {
	const base = sessionTitle.get(sessionId) || sessionAgentId.get(sessionId) || 'Agent';
	return base + ' ' + ordinal;
}

/** Which session a given event payload is about. `agent.statusChanged` is the
 * one topic whose `tabId` field actually carries the session id - see the
 * host facts in Phase-01-Plugin-Scaffold-And-Live-Board.md. */
function sessionIdForEvent(topic, payload) {
	if (!payload) return undefined;
	if (topic === 'agent.statusChanged') {
		return typeof payload.tabId === 'string' ? payload.tabId : undefined;
	}
	return typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
}

function markDirty(sessionId) {
	if (!sessionId) return;
	dirtySessions.add(sessionId);
	sessionLastActivity.set(sessionId, Date.now());
	scheduleRefresh();
}

function rebuildSessionMeta(sessions) {
	for (const s of Array.isArray(sessions) ? sessions : []) {
		if (!s || typeof s.id !== 'string') continue;
		if (typeof s.title === 'string') sessionTitle.set(s.id, s.title);
		if (typeof s.agentId === 'string') sessionAgentId.set(s.id, s.agentId);
		if (typeof s.projectPath === 'string') sessionProjectPath.set(s.id, s.projectPath);
	}
}

/** Full rebuild of the card model from one maestro.tabs.list() response.
 * tabs.list() always returns every tab (it takes no session filter), so a
 * full rebuild keeps every session in sync in one pass rather than patching
 * just the sessions that triggered this refresh. */
function rebuildCardsFromTabs(tabs) {
	const next = new Map();
	const ordinals = new Map();
	for (const tab of Array.isArray(tabs) ? tabs : []) {
		if (!tab || typeof tab !== 'object') continue;
		if (tab.type !== 'ai') continue; // terminal tabs are never cards
		if (typeof tab.sessionId !== 'string' || typeof tab.id !== 'string') continue;
		const sessionId = tab.sessionId;
		const ordinal = (ordinals.get(sessionId) || 0) + 1;
		ordinals.set(sessionId, ordinal);
		const key = cardKey(sessionId, tab.id);
		const existing = cards.get(key);
		const title =
			typeof tab.title === 'string' && tab.title ? tab.title : fallbackTitle(sessionId, ordinal);
		const status = typeof tab.status === 'string' ? tab.status : 'idle';
		const createdAt =
			typeof tab.createdAt === 'number'
				? tab.createdAt
				: existing
					? existing.createdAt
					: Date.now();
		const projectPath =
			typeof tab.projectPath === 'string'
				? tab.projectPath
				: sessionProjectPath.get(sessionId) || (existing ? existing.projectPath : undefined);
		const card = {
			key: key,
			sessionId: sessionId,
			tabId: tab.id,
			title: title,
			agentId: sessionAgentId.get(sessionId) || (existing ? existing.agentId : undefined),
			projectPath: projectPath,
			status: status,
			createdAt: createdAt,
			lastActivityAt:
				sessionLastActivity.get(sessionId) || (existing ? existing.lastActivityAt : createdAt),
			columnId: null,
		};
		card.columnId = deriveColumn(card);
		next.set(key, card);
	}
	cards = next;
}

function scheduleRefresh() {
	if (refreshTimer) return;
	refreshTimer = setTimeout(() => {
		refreshTimer = null;
		doRefresh();
	}, REFRESH_DEBOUNCE_MS);
}

function doRefresh() {
	if (!sdk) return;
	dirtySessions.clear();
	sdk.tabs
		.list()
		.then((tabs) => {
			rebuildCardsFromTabs(tabs);
			schedulePanelPush();
		})
		.catch((err) => {
			// A rejected RPC degrades this refresh only; existing cards are left
			// as they were rather than wiping the board.
			console.error('maestro-kanban: tabs.list failed: ' + String(err));
		});
}

function schedulePanelPush() {
	if (panelTimer) return;
	panelTimer = setTimeout(() => {
		panelTimer = null;
		pushSnapshotNow();
	}, PANEL_PUSH_DEBOUNCE_MS);
}

function cardToJson(card) {
	return {
		key: card.key,
		sessionId: card.sessionId,
		tabId: card.tabId,
		title: card.title,
		agentId: card.agentId,
		projectPath: card.projectPath,
		status: card.status,
		createdAt: card.createdAt,
		lastActivityAt: card.lastActivityAt,
	};
}

function buildSnapshot() {
	const byColumn = new Map(COLUMN_IDS.map((id) => [id, []]));
	const ordered = Array.from(cards.values()).sort((a, b) => a.createdAt - b.createdAt);
	for (const card of ordered) {
		const list = byColumn.get(card.columnId) || byColumn.get('backlog');
		list.push(cardToJson(card));
	}
	return {
		updatedAt: Date.now(),
		columns: COLUMN_IDS.map((id) => ({ id: id, cards: byColumn.get(id) })),
	};
}

function serializedSize(snapshot) {
	try {
		return JSON.stringify(snapshot).length;
	} catch {
		return Infinity;
	}
}

/** Trim a snapshot under budget: first drop optional fields from every card,
 * then drop the oldest card per column (round-robin) until it fits. */
function trimToBudget(snapshot) {
	if (serializedSize(snapshot) <= PANEL_BUDGET_BYTES) return { snapshot: snapshot, trimmed: false };
	for (const column of snapshot.columns) {
		column.cards = column.cards.map((c) => ({
			key: c.key,
			sessionId: c.sessionId,
			tabId: c.tabId,
			title: c.title,
			agentId: c.agentId,
			status: c.status,
			lastActivityAt: c.lastActivityAt,
		}));
	}
	let guard = 0;
	while (serializedSize(snapshot) > PANEL_BUDGET_BYTES && guard < 10000) {
		guard++;
		let droppedAny = false;
		for (const column of snapshot.columns) {
			if (column.cards.length > 0) {
				column.cards.shift();
				droppedAny = true;
				if (serializedSize(snapshot) <= PANEL_BUDGET_BYTES) break;
			}
		}
		if (!droppedAny) break;
	}
	return { snapshot: snapshot, trimmed: true };
}

function safeToast(message) {
	if (!sdk) return Promise.resolve();
	return sdk.notifications.toast(message).catch(() => {});
}

function pushSnapshotNow() {
	if (panelTimer) {
		clearTimeout(panelTimer);
		panelTimer = null;
	}
	if (!sdk) return;
	const result = trimToBudget(buildSnapshot());
	if (result.trimmed) {
		console.warn('maestro-kanban: board snapshot exceeded the panel budget and was trimmed');
		safeToast('Kanban board is large; some card detail was trimmed to fit the panel.');
	}
	sdk.ui.panelPost('board', result.snapshot).catch((err) => {
		console.error('maestro-kanban: panelPost failed: ' + String(err));
	});
}

function onSessionCreated(payload) {
	if (!payload || typeof payload.sessionId !== 'string') return;
	if (typeof payload.title === 'string') sessionTitle.set(payload.sessionId, payload.title);
	if (typeof payload.agentId === 'string') sessionAgentId.set(payload.sessionId, payload.agentId);
	if (typeof payload.projectPath === 'string')
		sessionProjectPath.set(payload.sessionId, payload.projectPath);
	markDirty(payload.sessionId);
}

function onSessionUpdated(payload) {
	if (!payload || typeof payload.sessionId !== 'string') return;
	if (typeof payload.title === 'string') sessionTitle.set(payload.sessionId, payload.title);
	markDirty(payload.sessionId);
}

/** session.removed drops that session's cards immediately, with no
 * maestro.tabs.list() re-read - the host already told us it is gone. */
function onSessionRemoved(payload) {
	if (!payload || typeof payload.sessionId !== 'string') return;
	const sessionId = payload.sessionId;
	sessionTitle.delete(sessionId);
	sessionAgentId.delete(sessionId);
	sessionProjectPath.delete(sessionId);
	sessionLastActivity.delete(sessionId);
	dirtySessions.delete(sessionId);
	let removedAny = false;
	for (const [key, card] of cards) {
		if (card.sessionId === sessionId) {
			cards.delete(key);
			removedAny = true;
		}
	}
	if (removedAny) schedulePanelPush();
}

function onGenericSessionEvent(topic, payload) {
	markDirty(sessionIdForEvent(topic, payload));
}

function registerEventHandlers(maestro) {
	maestro.events.on('session.created', onSessionCreated);
	maestro.events.on('session.updated', onSessionUpdated);
	maestro.events.on('session.removed', onSessionRemoved);
	maestro.events.on('session.activated', (payload) =>
		onGenericSessionEvent('session.activated', payload)
	);
	maestro.events.on('agent.statusChanged', (payload) =>
		onGenericSessionEvent('agent.statusChanged', payload)
	);
	maestro.events.on('agent.completed', (payload) =>
		onGenericSessionEvent('agent.completed', payload)
	);
	maestro.events.on('agent.error', (payload) => onGenericSessionEvent('agent.error', payload));
	maestro.events.on('agent.exited', (payload) => onGenericSessionEvent('agent.exited', payload));
	maestro.events.on('run.completed', (payload) => onGenericSessionEvent('run.completed', payload));
	maestro.events.on('usage.updated', (payload) => onGenericSessionEvent('usage.updated', payload));
}

/** Re-seed everything from sessions.list()/tabs.list() and push right away.
 * Used at activate() and by the 'refresh' command. A rejected sessions.list()
 * still lets tabs.list() run, so the board degrades rather than going blank. */
async function seed() {
	try {
		const sessions = await sdk.sessions.list();
		rebuildSessionMeta(sessions);
	} catch (err) {
		console.error('maestro-kanban: sessions.list failed: ' + String(err));
	}
	try {
		const tabs = await sdk.tabs.list();
		rebuildCardsFromTabs(tabs);
	} catch (err) {
		console.error('maestro-kanban: tabs.list failed: ' + String(err));
	}
	pushSnapshotNow();
}

function registerCommands(maestro) {
	maestro.commands.register('open', () => maestro.ui.togglePanel('board').catch(() => {}));

	maestro.commands.register('refresh', () => {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
		dirtySessions.clear();
		return seed();
	});

	// Phase 01 has no stored placement to clear; Phase 02 owns storage.
	maestro.commands.register('clear-placements', () => Promise.resolve({ ok: true }));

	// Invoked by the panel via parent.postMessage; no manifest `commands`
	// entry is needed since it is never surfaced in the command palette.
	maestro.commands.register('focus', (args) => {
		const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : undefined;
		const tabId = args && typeof args.tabId === 'string' ? args.tabId : undefined;
		if (!sessionId) return Promise.resolve({ ok: false });
		return maestro.sessions
			.focus(sessionId, tabId)
			.then(() => ({ ok: true }))
			.catch((err) => {
				console.error('maestro-kanban: sessions.focus failed: ' + String(err));
				return safeToast('Could not jump to that agent.').then(() => ({ ok: false }));
			});
	});
}

module.exports = {
	/** @param {MaestroSdk} maestro */
	async activate(maestro) {
		sdk = maestro;
		registerCommands(maestro);
		registerEventHandlers(maestro);
		try {
			await maestro.events.subscribe(EVENT_TOPICS);
		} catch (err) {
			console.error('maestro-kanban: events.subscribe failed: ' + String(err));
		}
		await seed();
	},

	deactivate() {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
		if (panelTimer) {
			clearTimeout(panelTimer);
			panelTimer = null;
		}
		dirtySessions.clear();
		cards = new Map();
		if (sdk) {
			return sdk.events.unsubscribe().catch(() => {});
		}
		return undefined;
	},
};
