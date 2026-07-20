// Agent Flow - tier-2 Maestro plugin sandbox entry.
//
// Plain CommonJS run through `new vm.Script` inside a utilityProcess: no
// imports, no `require`, no Node built-ins. The only host access is the frozen
// `maestro` SDK (passed to `activate` and also available as a global). Standard
// JS intrinsics (JSON, Date, Map, Math, setTimeout) are available.
//
// Behavior: subscribe to the metadata-only host event stream, maintain a
// per-session execution-graph model (one lane per session, tool-call nodes per
// lane), and push coalesced snapshots to the `flow` panel via
// `maestro.ui.panelPost`. Everything observed here is metadata only - tool
// names, timing, and lifecycle phase - never arguments, results, or output.

'use strict';

/** @typedef {import('@maestro/plugin-sdk').MaestroSdk} MaestroSdk */

// ---- constants -------------------------------------------------------------

var TOPICS = [
	'tool.executed',
	'agent.statusChanged',
	'agent.awaiting',
	'agent.completed',
	'agent.error',
	'agent.exited',
	'run.completed',
	'usage.updated',
	'session.created',
	'session.updated',
	'session.removed',
];

// Most recent nodes retained per lane before oldest are dropped.
var LANE_NODE_CAP = 300;
// Trailing-edge coalescing window for panel pushes.
var SNAPSHOT_COALESCE_MS = 250;
// Keep the JSON well under the host's 64 KB panelPost cap.
var SNAPSHOT_MAX_BYTES = 60000;

// ---- model -----------------------------------------------------------------

// sessionId -> lane. A lane is
//   { sessionId, title, agentId, status, usage, nodes: [], lastActivity, open }
// where `open` maps an in-flight toolCallId to the node it opened, and each
// node is { toolCallId, toolName, phase, startedAt, endedAt, durationMs }.
var lanes = new Map();
var lastEventAt = 0;
var snapshotTimer = 0;
/** @type {MaestroSdk | null} */
var sdk = null;

function getLane(sessionId) {
	var lane = lanes.get(sessionId);
	if (!lane) {
		lane = {
			sessionId: sessionId,
			title: '',
			agentId: '',
			status: '',
			usage: null,
			nodes: [],
			lastActivity: 0,
			open: Object.create(null),
			// Health metadata (issue #1231). `lastActivityAt` is a wall-clock ms
			// epoch (Date.now) refreshed on real activity so the panel can compute
			// an elapsed timer / stall warning against its own live clock;
			// `runningToolCount` tracks in-flight tool nodes independently of the
			// capped `nodes` array; `awaiting` marks a lane blocked on input;
			// `lastError` holds the last agent.error metadata until cleared.
			lastActivityAt: Date.now(),
			runningToolCount: 0,
			awaiting: false,
			lastError: null,
		};
		lanes.set(sessionId, lane);
	}
	return lane;
}

function touch(lane, at) {
	if (typeof at === 'number' && at > lane.lastActivity) lane.lastActivity = at;
}

// Trim a lane to the most recent LANE_NODE_CAP nodes, forgetting any open
// entries whose node was dropped.
function trimLane(lane) {
	var overflow = lane.nodes.length - LANE_NODE_CAP;
	if (overflow <= 0) return;
	var dropped = lane.nodes.splice(0, overflow);
	for (var i = 0; i < dropped.length; i++) {
		var d = dropped[i];
		if (d.toolCallId && lane.open[d.toolCallId] === d) {
			delete lane.open[d.toolCallId];
			// The node we can no longer track was still in flight; drop it from the
			// running count so a later close (which will not match) cannot inflate it.
			if (lane.runningToolCount > 0) lane.runningToolCount--;
		}
	}
}

// Is `phase` an explicit "starting" phase (vs a terminal one)?
function isOpenPhase(phase) {
	if (typeof phase !== 'string') return false;
	switch (phase.toLowerCase()) {
		case 'running':
		case 'started':
		case 'start':
		case 'in_progress':
		case 'pending':
			return true;
		default:
			return false;
	}
}

function pushNode(lane, node) {
	lane.nodes.push(node);
	trimLane(lane);
}

// Merge a tool.executed event into a lane.
function applyTool(payload, at) {
	if (!payload || typeof payload.sessionId !== 'string') return;
	var lane = getLane(payload.sessionId);
	var toolName = typeof payload.toolName === 'string' ? payload.toolName : 'tool';
	var phase = typeof payload.phase === 'string' ? payload.phase : undefined;
	var toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined;
	var durMs = typeof payload.durationMs === 'number' ? payload.durationMs : undefined;

	if (toolCallId) {
		var openNode = lane.open[toolCallId];
		if (openNode) {
			// A later phase closes the node the "running" phase opened.
			openNode.phase = phase !== undefined ? phase : openNode.phase;
			openNode.endedAt = at;
			openNode.toolName = toolName || openNode.toolName;
			openNode.durationMs = durMs !== undefined ? durMs : Math.max(0, at - openNode.startedAt);
			delete lane.open[toolCallId];
			if (lane.runningToolCount > 0) lane.runningToolCount--;
		} else if (isOpenPhase(phase)) {
			// Open a new in-flight node.
			var node = {
				toolCallId: toolCallId,
				toolName: toolName,
				phase: phase,
				startedAt: at,
				endedAt: undefined,
				durationMs: undefined,
			};
			lane.open[toolCallId] = node;
			pushNode(lane, node);
			lane.runningToolCount++;
			// Fresh tool work opening means any prior error thread has moved on.
			lane.lastError = null;
		} else {
			// Terminal (or phase-less) event with no prior open node: a single
			// closed node.
			pushNode(lane, {
				toolCallId: toolCallId,
				toolName: toolName,
				phase: phase,
				startedAt: at,
				endedAt: at,
				durationMs: durMs !== undefined ? durMs : 0,
			});
		}
	} else {
		// No toolCallId: append a single closed node.
		pushNode(lane, {
			toolCallId: undefined,
			toolName: toolName,
			phase: phase,
			startedAt: at,
			endedAt: at,
			durationMs: durMs !== undefined ? durMs : 0,
		});
	}
	// Any tool activity means the session is doing something now: it is no longer
	// blocked on input, and this counts as fresh activity for the stall clock.
	lane.awaiting = false;
	lane.lastActivityAt = Date.now();
	touch(lane, at);
}

function resetModel() {
	lanes.clear();
}

// ---- event handlers --------------------------------------------------------

function eventTime(payload, meta) {
	if (payload && typeof payload.timestamp === 'number') return payload.timestamp;
	if (meta && typeof meta.at === 'string') {
		var t = Date.parse(meta.at);
		if (!isNaN(t)) return t;
	}
	return lastEventAt || Date.now();
}

// agent.statusChanged / agent.awaiting carry an agentId, not a sessionId. Prefer
// an existing lane whose agentId matches; else key a lane by the agentId itself.
function resolveByAgentId(agentId) {
	var target = null;
	lanes.forEach(function (lane) {
		if (!target && lane.agentId === agentId) target = lane;
	});
	if (!target) target = getLane(agentId);
	return target;
}

var HANDLERS = {
	'tool.executed': function (payload, at) {
		applyTool(payload, at);
	},
	'agent.statusChanged': function (payload, at) {
		if (!payload || typeof payload.agentId !== 'string') return;
		var target = resolveByAgentId(payload.agentId);
		if (typeof payload.status === 'string') {
			target.status = payload.status;
			// A coarse waiting_input status is the same signal as agent.awaiting.
			if (payload.status === 'waiting_input') target.awaiting = true;
		}
		target.lastActivityAt = Date.now();
		touch(target, at);
	},
	'agent.awaiting': function (payload, at) {
		if (!payload || typeof payload.agentId !== 'string') return;
		var target = resolveByAgentId(payload.agentId);
		// Blocked on input: not a stall, and not fresh tool activity, so leave
		// lastActivityAt untouched (the panel renders "Waiting for input").
		target.awaiting = true;
		touch(target, at);
	},
	'agent.completed': function (payload, at) {
		if (!payload || typeof payload.sessionId !== 'string') return;
		var lane = getLane(payload.sessionId);
		if (typeof payload.status === 'string') lane.status = payload.status;
		if (typeof payload.agentId === 'string' && !lane.agentId) lane.agentId = payload.agentId;
		// The run reached a terminal state: it is no longer waiting, and a clean
		// completion clears any lingering error thread.
		lane.awaiting = false;
		if (payload.status === 'completed') lane.lastError = null;
		touch(lane, at);
	},
	'agent.error': function (payload, at) {
		if (!payload || typeof payload.sessionId !== 'string') return;
		var lane = getLane(payload.sessionId);
		lane.status = 'error';
		lane.lastError = {
			errorType: typeof payload.errorType === 'string' ? payload.errorType : 'error',
			recoverable: !!payload.recoverable,
			at: Date.now(),
		};
		touch(lane, at);
	},
	'agent.exited': function (payload, at) {
		if (!payload || typeof payload.sessionId !== 'string') return;
		var lane = getLane(payload.sessionId);
		lane.status = payload.exitCode === 0 ? 'exited' : 'error';
		touch(lane, at);
	},
	'run.completed': function (payload, at) {
		if (!payload || typeof payload.sessionId !== 'string') return;
		touch(getLane(payload.sessionId), at);
	},
	'usage.updated': function (payload, at) {
		if (!payload || typeof payload.sessionId !== 'string') return;
		var lane = getLane(payload.sessionId);
		lane.usage = {
			inputTokens: num(payload.inputTokens),
			outputTokens: num(payload.outputTokens),
			cacheReadInputTokens: num(payload.cacheReadInputTokens),
			cacheCreationInputTokens: num(payload.cacheCreationInputTokens),
			totalCostUsd: num(payload.totalCostUsd),
			contextWindow: num(payload.contextWindow),
			reasoningTokens: num(payload.reasoningTokens),
		};
		// Token accounting means the model produced output: fresh activity, and
		// proof it is no longer blocked on input.
		lane.awaiting = false;
		lane.lastActivityAt = Date.now();
		touch(lane, at);
	},
	'session.created': function (payload, at) {
		if (!payload || typeof payload.sessionId !== 'string') return;
		var lane = getLane(payload.sessionId);
		if (typeof payload.title === 'string') lane.title = payload.title;
		if (typeof payload.agentId === 'string') lane.agentId = payload.agentId;
		touch(lane, at);
	},
	'session.updated': function (payload, at) {
		if (!payload || typeof payload.sessionId !== 'string') return;
		var lane = getLane(payload.sessionId);
		if (typeof payload.title === 'string') lane.title = payload.title;
		if (typeof payload.status === 'string') lane.status = payload.status;
		lane.lastActivityAt = Date.now();
		touch(lane, at);
	},
	'session.removed': function (payload) {
		if (!payload || typeof payload.sessionId !== 'string') return;
		lanes.delete(payload.sessionId);
	},
};

function num(v) {
	return typeof v === 'number' && isFinite(v) ? v : 0;
}

function onEvent(topic, payload, meta) {
	var handler = HANDLERS[topic];
	if (!handler) return;
	var at = eventTime(payload, meta);
	lastEventAt = at;
	handler(payload, at);
	scheduleSnapshot();
}

// ---- snapshot pushing ------------------------------------------------------

// UTF-8 byte length without relying on TextEncoder/Buffer (absent in sandbox).
function utf8Len(s) {
	var n = 0;
	for (var i = 0; i < s.length; i++) {
		var c = s.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff) {
			n += 4;
			i++;
		} else n += 3;
	}
	return n;
}

function laneSnapshot(lane, cap) {
	var nodes = lane.nodes;
	if (nodes.length > cap) nodes = nodes.slice(nodes.length - cap);
	var out = new Array(nodes.length);
	for (var i = 0; i < nodes.length; i++) {
		var n = nodes[i];
		out[i] = {
			toolCallId: n.toolCallId,
			toolName: n.toolName,
			phase: n.phase,
			startedAt: n.startedAt,
			endedAt: n.endedAt,
			durationMs: n.durationMs,
		};
	}
	return {
		sessionId: lane.sessionId,
		title: lane.title,
		agentId: lane.agentId,
		status: lane.status,
		usage: lane.usage,
		nodes: out,
		lastActivityAt: lane.lastActivityAt,
		runningToolCount: lane.runningToolCount,
		awaiting: lane.awaiting,
		lastError: lane.lastError,
	};
}

// Fleet-wide health rollup (issue #1231) for the panel's activity strip.
function buildSummary(ordered) {
	var busyLanes = 0;
	var runningTools = 0;
	var awaitingLanes = 0;
	var erroredLanes = 0;
	for (var i = 0; i < ordered.length; i++) {
		var lane = ordered[i];
		var s = String(lane.status || '').toLowerCase();
		if (s === 'busy' || s === 'connecting') busyLanes++;
		runningTools += lane.runningToolCount || 0;
		if (lane.awaiting) awaitingLanes++;
		if (lane.lastError) erroredLanes++;
	}
	return {
		busyLanes: busyLanes,
		runningTools: runningTools,
		awaitingLanes: awaitingLanes,
		erroredLanes: erroredLanes,
	};
}

function sortedLanes() {
	var arr = [];
	lanes.forEach(function (lane) {
		arr.push(lane);
	});
	// Most recent activity first.
	arr.sort(function (a, b) {
		return b.lastActivity - a.lastActivity;
	});
	return arr;
}

function buildSnapshot(cap) {
	var ordered = sortedLanes();
	var out = new Array(ordered.length);
	for (var i = 0; i < ordered.length; i++) out[i] = laneSnapshot(ordered[i], cap);
	return { v: 1, at: lastEventAt, lanes: out, summary: buildSummary(ordered) };
}

function pushSnapshot() {
	if (!sdk) return;
	var cap = LANE_NODE_CAP;
	var snap = buildSnapshot(cap);
	var json = JSON.stringify(snap);
	// Guard the 64 KB panel-post cap: halve the per-lane node cap until it fits,
	// dropping oldest nodes first.
	while (utf8Len(json) > SNAPSHOT_MAX_BYTES && cap > 1) {
		cap = Math.floor(cap / 2);
		snap = buildSnapshot(cap);
		json = JSON.stringify(snap);
	}
	try {
		var p = sdk.ui.panelPost('flow', snap);
		// panelPost is a brokered async call; swallow denial (ui:panel not yet
		// granted) so we simply retry on the next mutation.
		if (p && typeof p.then === 'function') p.then(undefined, function () {});
	} catch (e) {
		/* denial or bridge gone; retry next mutation */
	}
}

function scheduleSnapshot() {
	// At most one push per SNAPSHOT_COALESCE_MS (trailing edge).
	if (snapshotTimer) return;
	snapshotTimer = setTimeout(function () {
		snapshotTimer = 0;
		pushSnapshot();
	}, SNAPSHOT_COALESCE_MS);
}

// ---- startup ---------------------------------------------------------------

// Seed lane titles / agent ids from currently-open sessions. Tolerates denial
// if the sessions:read grant is missing.
function seedFromSessions() {
	if (!sdk) return;
	try {
		var p = sdk.sessions.list();
		if (!p || typeof p.then !== 'function') return;
		p.then(
			function (list) {
				if (!Array.isArray(list)) return;
				for (var i = 0; i < list.length; i++) {
					var s = list[i];
					if (!s || typeof s.id !== 'string') continue;
					var lane = getLane(s.id);
					if (typeof s.title === 'string') lane.title = s.title;
					if (typeof s.agentId === 'string') lane.agentId = s.agentId;
					if (typeof s.status === 'string') lane.status = s.status;
				}
				scheduleSnapshot();
			},
			function () {
				/* grant missing; tolerate */
			}
		);
	} catch (e) {
		/* tolerate */
	}
}

function activate(maestro) {
	sdk = maestro;
	console.log('[agent-flow] starting up');

	// Register in-realm handlers, then ask the host to deliver these topics.
	for (var i = 0; i < TOPICS.length; i++) {
		(function (topic) {
			maestro.events.on(topic, function (payload, meta) {
				onEvent(topic, payload, meta);
			});
		})(TOPICS[i]);
	}
	try {
		var sub = maestro.events.subscribe(TOPICS);
		if (sub && typeof sub.then === 'function') sub.then(undefined, function () {});
	} catch (e) {
		/* subscription denial is tolerated; handlers simply never fire */
	}

	// The contributed "clear" command resets the whole graph.
	maestro.commands.register('clear', function () {
		resetModel();
		scheduleSnapshot();
	});

	seedFromSessions();
}

function deactivate() {
	if (snapshotTimer) {
		clearTimeout(snapshotTimer);
		snapshotTimer = 0;
	}
	resetModel();
	sdk = null;
}

module.exports = { activate: activate, deactivate: deactivate };
