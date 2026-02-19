/**
 * Agent Status Exporter Plugin
 *
 * Exports real-time agent status to a JSON file for external consumption.
 * Main-process-only plugin — no renderer/iframe UI.
 *
 * A heartbeat timer writes status every 10 seconds even when idle,
 * so consumers can distinguish "no active agents" from "stale data."
 */

const fsPromises = require('fs').promises;
const pathModule = require('path');

const LOG_TAG = '[agent-status-exporter]';
const HEARTBEAT_INTERVAL_MS = 10000;

/** @type {Map<string, object>} */
const agents = new Map();

let debounceTimer = null;
let heartbeatTimer = null;
let api = null;

function debounceWriteStatus() {
	if (debounceTimer) {
		clearTimeout(debounceTimer);
	}
	debounceTimer = setTimeout(() => {
		debounceTimer = null;
		writeStatus();
	}, 500);
}

async function writeStatus() {
	if (!api) return;

	try {
		const now = Date.now();
		const agentList = [];
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let totalCost = 0;
		let activeAgents = 0;

		for (const agent of agents.values()) {
			const runtimeSeconds = Math.floor((now - agent.startTime) / 1000);
			agentList.push({
				sessionId: agent.sessionId,
				agentType: agent.agentType,
				pid: agent.pid,
				startTime: agent.startTime,
				runtimeSeconds,
				status: agent.status,
				tokens: { ...agent.tokens },
				cost: agent.cost,
				lastTool: agent.lastTool ? { ...agent.lastTool } : null,
			});

			if (agent.status === 'active') {
				activeAgents++;
			}
			totalInputTokens += agent.tokens.input;
			totalOutputTokens += agent.tokens.output;
			totalCost += agent.cost;
		}

		const output = {
			timestamp: now,
			agents: agentList,
			totals: {
				activeAgents,
				totalInputTokens,
				totalOutputTokens,
				totalCost,
			},
		};

		const json = JSON.stringify(output, null, 2);

		// Check for custom output path; fall back to encore storage.
		// api.settings is always available since this encore declares settings:read.
		const customPath = await api.settings.get('outputPath');

		if (customPath && typeof customPath === 'string' && pathModule.isAbsolute(customPath)) {
			await fsPromises.mkdir(pathModule.dirname(customPath), { recursive: true });
			await fsPromises.writeFile(customPath, json, 'utf-8');
		} else {
			await api.storage.write('status.json', json);
		}
	} catch (err) {
		// Filesystem permission/access errors are expected (e.g., user-configured
		// outputPath becomes inaccessible). Log but don't escalate — the heartbeat
		// interval must keep running so subsequent writes can succeed.
		const code = err && err.code;
		if (code === 'EACCES' || code === 'EPERM' || code === 'ENOSPC' || code === 'EROFS') {
			console.warn(`${LOG_TAG} Write failed (${code}):`, err.message);
			return;
		}

		// Unexpected error — log with full stack for debugging. Cannot rethrow
		// because writeStatus is called from setInterval/setTimeout and an
		// unhandled rejection would crash the main process.
		console.error(`${LOG_TAG} Unexpected error writing status:`, err);
	}
}

function ensureAgent(sessionId) {
	if (!agents.has(sessionId)) {
		agents.set(sessionId, {
			sessionId,
			agentType: 'unknown',
			pid: 0,
			startTime: Date.now(),
			tokens: { input: 0, output: 0, cacheRead: 0, contextWindow: 0 },
			cost: 0,
			lastTool: null,
			status: 'active',
			exitedAt: null,
		});
	}
	return agents.get(sessionId);
}

async function activate(pluginApi) {
	api = pluginApi;

	// Seed initial state from already-running agents
	try {
		const active = await api.process.getActiveProcesses();
		for (const proc of active) {
			const agent = ensureAgent(proc.sessionId);
			agent.agentType = proc.toolType || 'unknown';
			agent.pid = proc.pid || 0;
			agent.startTime = proc.startTime || Date.now();
		}
	} catch (err) {
		console.error(`${LOG_TAG} Failed to get active processes:`, err);
	}

	// Subscribe to usage updates
	api.process.onUsage((sessionId, stats) => {
		const agent = ensureAgent(sessionId);
		if (stats.inputTokens !== undefined) agent.tokens.input = stats.inputTokens;
		if (stats.outputTokens !== undefined) agent.tokens.output = stats.outputTokens;
		if (stats.cacheReadTokens !== undefined) agent.tokens.cacheRead = stats.cacheReadTokens;
		if (stats.contextWindow !== undefined) agent.tokens.contextWindow = stats.contextWindow;
		if (stats.totalCostUsd !== undefined) agent.cost = stats.totalCostUsd;
		debounceWriteStatus();
	});

	// Subscribe to tool executions
	api.process.onToolExecution((sessionId, tool) => {
		const agent = ensureAgent(sessionId);
		agent.lastTool = {
			name: tool?.toolName ?? 'unknown',
			timestamp: Date.now(),
		};
		debounceWriteStatus();
	});

	// Subscribe to agent exits
	api.process.onExit((sessionId, code) => {
		const agent = agents.get(sessionId);
		if (agent) {
			agent.status = 'exited';
			agent.exitedAt = Date.now();
			debounceWriteStatus();

			// Remove exited agent after 30 seconds
			setTimeout(() => {
				agents.delete(sessionId);
				debounceWriteStatus();
			}, 30000);
		}
	});

	// Subscribe to data events to catch agents that started between getActiveProcesses and subscriptions
	api.process.onData((sessionId, _data) => {
		if (!agents.has(sessionId)) {
			ensureAgent(sessionId);
			debounceWriteStatus();
		}
	});

	// Write initial status immediately
	await writeStatus();

	// Start heartbeat — writes status every 10s even when idle so consumers
	// always see a fresh timestamp and know Maestro is running
	heartbeatTimer = setInterval(() => {
		writeStatus();
	}, HEARTBEAT_INTERVAL_MS);
}

async function deactivate() {
	// Clear pending timers
	if (debounceTimer) {
		clearTimeout(debounceTimer);
		debounceTimer = null;
	}
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}

	// Mark all agents as exited and write final status
	for (const agent of agents.values()) {
		agent.status = 'exited';
		agent.exitedAt = Date.now();
	}
	await writeStatus();

	// Cleanup
	agents.clear();
	api = null;
}

module.exports = { activate, deactivate };
