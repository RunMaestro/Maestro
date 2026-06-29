// maestro-bridge: the single omp extension that makes an omp session a
// first-class Maestro citizen. It (1) registers Maestro `maestro_*` tools, (2)
// streams session lifecycle to the Maestro session-ingest endpoint so the
// desktop app tracks the run live, and (3) maintains the identity map so the
// session can be resumed from either side.
//
// Loaded by omp via `-e` under Bun. It is trusted first-party code (omp
// extensions are NOT sandboxed); it must stay first-party and version-pinned,
// never a third-party plugin. Tools that resolve to agent execution are
// registered but INERT until Phase 4.

import { randomUUID } from 'node:crypto';
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
} from '@oh-my-pi/pi-coding-agent';
import { createBridgeClient } from '../bridge-client';
import { BRIDGE_ENV, type BridgeResponse, type SessionEventKind, parseNotify } from '../protocol';
import { findByOmpSessionId, touchRecord, upsertRecord } from '../session-map';

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string): string | undefined {
	if (!isObject(value)) return undefined;
	const candidate = value[key];
	return typeof candidate === 'string' ? candidate : undefined;
}

// Whitelist numeric usage fields only. Forwarding the raw usage object would
// risk leaking nested transcript/content if the upstream shape ever changes;
// metadata-only means token counts, nothing else.
function pickUsage(value: unknown): Record<string, number> | undefined {
	if (!isObject(value)) return undefined;
	const usage: Record<string, number> = {};
	for (const [key, candidate] of Object.entries(value)) {
		if (typeof candidate === 'number' && Number.isFinite(candidate)) usage[key] = candidate;
	}
	return Object.keys(usage).length > 0 ? usage : undefined;
}

function text(message: string): AgentToolResult {
	return { content: [{ type: 'text', text: message }] };
}

function renderResponse(response: BridgeResponse<unknown>, successText?: string): AgentToolResult {
	if (response.ok) {
		const body = successText ?? JSON.stringify(response.result, null, 2);
		return { content: [{ type: 'text', text: body }], details: { ok: true } };
	}
	return {
		content: [
			{ type: 'text', text: `Maestro bridge: ${response.error.message} (${response.error.code})` },
		],
		details: { ok: false, code: response.error.code },
	};
}

export function pickMessageData(event: ExtensionEvent): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	const role = readString(event, 'role');
	if (role) data.role = role;
	const usage =
		pickUsage(event.usage) ?? pickUsage(isObject(event.message) ? event.message.usage : undefined);
	if (usage) data.usage = usage;
	return data;
}

export function pickToolData(event: ExtensionEvent): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	const toolName = readString(event, 'toolName');
	if (toolName) data.toolName = toolName;
	const status = readString(event, 'status');
	if (status) data.status = status;
	return data;
}

const INERT_TOOLS: { name: string; label: string; description: string }[] = [
	{
		name: 'maestro_dispatch',
		label: 'Maestro Dispatch',
		description: 'Hand a sub-task to a sibling Maestro agent.',
	},
	{
		name: 'maestro_playbook_run',
		label: 'Maestro Run Playbook',
		description: 'Run or enqueue a Maestro playbook (spawns agents).',
	},
	{
		name: 'maestro_cue_emit',
		label: 'Maestro Emit Cue',
		description: 'Fire a Maestro cue (can resolve to agent dispatch).',
	},
];

export default function maestroBridge(pi: ExtensionAPI): void {
	const env: Record<string, string | undefined> = process.env;
	const client = createBridgeClient(env);
	const runId = env[BRIDGE_ENV.runId] ?? 'local';
	const resumeMaestroSessionId = env[BRIDGE_ENV.maestroSessionId];
	const mapPath = env[BRIDGE_ENV.mapPath];
	const z = pi.zod;

	pi.setLabel('Maestro');

	// --- Read / observe tools (live in Phase 2) --------------------------
	pi.registerTool({
		name: 'maestro_sessions',
		label: 'Maestro Sessions',
		description:
			'List the Maestro sessions the desktop app is tracking (id, title, status, project path). Use to see sibling work in progress.',
		parameters: z.object({}),
		async execute() {
			return renderResponse(await client.call('sessions.list', {}));
		},
	});

	pi.registerTool({
		name: 'maestro_playbook_list',
		label: 'Maestro Playbooks',
		description: 'List Maestro playbooks (metadata only) available in the desktop app.',
		parameters: z.object({}),
		async execute() {
			return renderResponse(await client.call('playbook.list', {}));
		},
	});

	pi.registerTool({
		name: 'maestro_cue',
		label: 'Maestro Cues',
		description: 'Observe Maestro Cue automations and recent cue activity (read-only).',
		parameters: z.object({}),
		async execute() {
			return renderResponse(await client.call('cue.observe', {}));
		},
	});

	pi.registerTool({
		name: 'maestro_notify',
		label: 'Maestro Notify',
		description: 'Show a toast notification in the Maestro desktop app.',
		parameters: z.object({ title: z.string(), message: z.string() }),
		async execute(_toolCallId, params) {
			const notify = parseNotify(params);
			if (!notify) return text('maestro_notify requires { title: string, message: string }');
			return renderResponse(await client.call('notify.toast', notify), 'Notification sent.');
		},
	});

	// --- Dispatch-equivalent tools (INERT until Phase 4) -----------------
	for (const tool of INERT_TOOLS) {
		pi.registerTool({
			name: tool.name,
			label: tool.label,
			description: `${tool.description} UNAVAILABLE until Phase 4 (dispatch-equivalent: can cause agent execution).`,
			parameters: z.object({}),
			async execute() {
				return text(
					`${tool.name} is gated until Phase 4. It is dispatch-equivalent (it can cause another agent to run arbitrary code) and is intentionally not wired yet.`
				);
			},
		});
	}

	// --- Session tracking ------------------------------------------------
	let ompSessionId: string | undefined;
	let maestroSessionId: string | undefined;
	let registered = false;

	async function resolveMaestroSessionId(ompId: string): Promise<string> {
		// Resume passes the existing id; otherwise reuse the id already mapped to
		// this omp session (so `omp --continue` stays the same Maestro session),
		// else mint a fresh stable id decoupled from the session file path.
		if (resumeMaestroSessionId) return resumeMaestroSessionId;
		if (mapPath) {
			const existing = await findByOmpSessionId(mapPath, ompId).catch(() => undefined);
			if (existing) return existing.maestroSessionId;
		}
		return `mae-${randomUUID()}`;
	}

	async function ensureRegistered(ctx: ExtensionContext): Promise<void> {
		if (registered) return;
		registered = true;
		ompSessionId = ctx.sessionManager.getSessionFile() ?? `run:${runId}`;
		maestroSessionId = await resolveMaestroSessionId(ompSessionId);
		const startedAt = Date.now();
		await client.call('session.register', {
			runId,
			ompSessionId,
			maestroSessionId,
			cwd: ctx.cwd,
			engine: 'omp',
			startedAt,
		});
		if (mapPath) {
			await upsertRecord(mapPath, {
				maestroSessionId,
				ompSessionId,
				engine: 'omp',
				cwd: ctx.cwd,
				runId,
				startedAt,
				lastActiveAt: startedAt,
			}).catch(() => undefined);
		}
	}

	async function emit(kind: SessionEventKind, data?: Record<string, unknown>): Promise<void> {
		if (!ompSessionId) return;
		await client.call('session.event', { runId, ompSessionId, kind, at: Date.now(), data });
		if (mapPath && maestroSessionId) {
			await touchRecord(mapPath, maestroSessionId, Date.now()).catch(() => undefined);
		}
	}

	pi.on('session_start', async (_event, ctx) => {
		await ensureRegistered(ctx);
	});
	pi.on('turn_start', async (_event, ctx) => {
		await ensureRegistered(ctx);
		await emit('turn_start');
	});
	pi.on('turn_end', async () => {
		await emit('turn_end');
	});
	pi.on('message_end', async (event) => {
		await emit('message', pickMessageData(event));
	});
	pi.on('tool_execution_end', async (event) => {
		await emit('tool', pickToolData(event));
	});
	pi.on('session_shutdown', async () => {
		if (!ompSessionId) return;
		await client.call('session.end', { runId, ompSessionId, at: Date.now(), status: 'completed' });
		if (mapPath && maestroSessionId) {
			await touchRecord(mapPath, maestroSessionId, Date.now()).catch(() => undefined);
		}
	});
}
