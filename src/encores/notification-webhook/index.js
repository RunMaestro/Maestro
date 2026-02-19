/**
 * Notification Webhook Plugin
 *
 * Sends HTTP POST requests on agent lifecycle events.
 * Main-process-only plugin — uses Node.js http/https modules directly.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

let api = null;
const unsubscribers = [];

/** Per-session rolling buffer of recent output (last ~1000 chars) */
const sessionOutput = new Map();
/** Per-session agent info cache (looked up on first data event) */
const sessionAgentType = new Map();
const sessionAgentName = new Map();
const MAX_BUFFER = 1000;

/**
 * Sends a webhook POST request.
 * Never throws — all errors are caught and logged.
 */
function sendWebhook(url, payload) {
	return new Promise((resolve) => {
		try {
			const parsed = new URL(url);
			const transport = parsed.protocol === 'https:' ? https : http;
			const body = JSON.stringify(payload);

			// Resolve 'localhost' to IPv4 127.0.0.1 to avoid IPv6 ::1 ECONNREFUSED
			const hostname = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname;

			const req = transport.request(
				{
					hostname,
					port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
					path: parsed.pathname + parsed.search,
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Content-Length': Buffer.byteLength(body),
					},
					timeout: 10000,
				},
				(res) => {
					// Consume response data to free memory
					res.resume();
					resolve({ status: res.statusCode });
				}
			);

			req.on('timeout', () => {
				req.destroy();
				console.error('[notification-webhook] Request timed out');
				resolve({ error: 'timeout' });
			});

			req.on('error', (err) => {
				console.error('[notification-webhook] Request error:', err.message);
				resolve({ error: err.message });
			});

			req.write(body);
			req.end();
		} catch (err) {
			console.error('[notification-webhook] Failed to send webhook:', err.message);
			resolve({ error: err.message });
		}
	});
}

/** Common error indicators in agent output */
const ERROR_PATTERNS = [
	'Error:',
	'FATAL',
	'panic:',
	'Traceback',
	'ECONNREFUSED',
	'ENOENT',
	'Permission denied',
];

function containsError(data) {
	if (typeof data !== 'string') return false;
	return ERROR_PATTERNS.some((pattern) => data.includes(pattern));
}

async function activate(pluginApi) {
	api = pluginApi;

	// Buffer recent output per session so we can include it in exit webhooks
	const unsubData = api.process.onData(async (sessionId, data) => {
		if (typeof data !== 'string') return;

		// Look up agent type on first data event for this session
		if (!sessionAgentType.has(sessionId)) {
			try {
				const procs = await api.process.getActiveProcesses();
				const proc = procs.find((p) => p.sessionId === sessionId);
				if (proc) {
					sessionAgentType.set(sessionId, proc.toolType);
					if (proc.name) sessionAgentName.set(sessionId, proc.name);
				}
			} catch {
				// Ignore lookup errors
			}
		}

		// Update rolling buffer
		const existing = sessionOutput.get(sessionId) || '';
		const updated = (existing + data).slice(-MAX_BUFFER);
		sessionOutput.set(sessionId, updated);

		// Check for error patterns
		if (!containsError(data)) return;

		try {
			const notifyOnError = await api.settings.get('notifyOnError');
			if (notifyOnError === false) return;

			const webhookUrl = await api.settings.get('webhookUrl');
			if (!webhookUrl) return;

			await sendWebhook(webhookUrl, {
				event: 'agent.error',
				sessionId,
				agentType: sessionAgentType.get(sessionId) || null,
				agentName: sessionAgentName.get(sessionId) || null,
				snippet: data.substring(0, 500),
				timestamp: Date.now(),
			});
		} catch (err) {
			console.error('[notification-webhook] Error handling data event:', err.message);
		}
	});
	unsubscribers.push(unsubData);

	// Subscribe to agent exits
	const unsubExit = api.process.onExit(async (sessionId, code) => {
		// Grab buffered output and agent info before cleanup
		const lastOutput = sessionOutput.get(sessionId) || '';
		const agentType = sessionAgentType.get(sessionId) || null;
		const agentName = sessionAgentName.get(sessionId) || null;
		sessionOutput.delete(sessionId);
		sessionAgentType.delete(sessionId);
		sessionAgentName.delete(sessionId);

		try {
			const notifyOnCompletion = await api.settings.get('notifyOnCompletion');
			if (notifyOnCompletion === false) return;

			const webhookUrl = await api.settings.get('webhookUrl');
			if (!webhookUrl) return;

			await sendWebhook(webhookUrl, {
				event: 'agent.exit',
				sessionId,
				agentType,
				agentName,
				exitCode: code,
				lastOutput: lastOutput.trim(),
				timestamp: Date.now(),
			});
		} catch (err) {
			console.error('[notification-webhook] Error handling exit event:', err.message);
		}
	});
	unsubscribers.push(unsubExit);
}

async function deactivate() {
	for (const unsub of unsubscribers) {
		try {
			unsub();
		} catch {
			// Ignore cleanup errors
		}
	}
	unsubscribers.length = 0;
	sessionOutput.clear();
	sessionAgentType.clear();
	sessionAgentName.clear();
	api = null;
}

module.exports = { activate, deactivate, sendWebhook, containsError };
