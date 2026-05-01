// Conversational PRD CLI commands — interactive PRD generation via the Maestro desktop app.
//
// Sessions are persisted by FileConversationalPrdStore to:
//   ~/.config/maestro/conversational-prd-sessions.json   (Linux/Windows)
//   ~/Library/Application Support/maestro/conversational-prd-sessions.json   (macOS)
//
// For debugging persistent sessions, inspect that file directly.
//
// All sub-commands communicate with the running Maestro app over the local HTTP API.
// The desktop app must be running with the Conversational PRD encore feature enabled.
//
// Sub-command tree:
//   maestro-cli conv-prd start [--initial <md>] [--project <path>]
//   maestro-cli conv-prd ask <sessionId> <message>
//   maestro-cli conv-prd show <sessionId> [--json]
//   maestro-cli conv-prd finalize <sessionId> [--handoff-to-planner]
//
// NOTE: list and archive are also available for session management:
//   maestro-cli conv-prd list [--json]
//   maestro-cli conv-prd archive <sessionId>

import { readCliServerInfo, isCliServerRunning } from '../../shared/cli-server-discovery';

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface ConvPrdApiError {
	success: false;
	code?: string;
	feature?: string;
	error?: string;
}

interface ConvPrdApiOk<T> {
	success: true;
	data: T;
	timestamp?: number;
}

type ConvPrdApiResult<T> = ConvPrdApiOk<T> | ConvPrdApiError;

/**
 * Build a base URL for the Conversational PRD HTTP API using the CLI discovery
 * file written by the running Maestro desktop app.
 *
 * Throws a descriptive Error when the app is not running or the discovery file
 * is stale — callers translate this into a CLI exit(1).
 */
function getBaseUrl(): string {
	const info = readCliServerInfo();
	if (!info) {
		throw new Error('Maestro desktop app is not running');
	}
	if (!isCliServerRunning()) {
		throw new Error('Maestro discovery file is stale (app may have crashed)');
	}
	return `http://127.0.0.1:${info.port}/${info.token}/api/conversational-prd`;
}

async function convPrdFetch<T>(path: string, options?: RequestInit): Promise<ConvPrdApiResult<T>> {
	const baseUrl = getBaseUrl();
	const url = `${baseUrl}${path}`;

	let res: Response;
	try {
		res = await fetch(url, {
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			...options,
		});
	} catch (err) {
		throw new Error(`Could not reach Maestro: ${err instanceof Error ? err.message : String(err)}`);
	}

	const body = (await res.json()) as ConvPrdApiResult<T>;

	// 403 means the conversationalPrd encore feature is disabled
	if (
		res.status === 403 ||
		(body && !body.success && (body as ConvPrdApiError).code === 'FEATURE_DISABLED')
	) {
		throw new Error(
			'Conversational PRD is disabled. Enable it in Maestro → Settings → Encore Features → Conversational PRD.'
		);
	}

	return body;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function exitWithError(message: string, json?: boolean, extra?: Record<string, unknown>): never {
	if (json) {
		console.log(JSON.stringify({ success: false, error: message, ...extra }, null, 2));
	} else {
		console.error(`Error: ${message}`);
	}
	process.exit(1);
}

// Minimal session shape we need for display purposes
interface ConvPrdSessionSummary {
	id: string;
	status?: string;
	metadata?: {
		title?: string;
		projectPath?: string;
		createdAt?: number;
		updatedAt?: number;
	};
	messages?: Array<{ role: string; content: string }>;
	draft?: {
		title?: string;
		summary?: string;
	};
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ConvPrdListOptions {
	json?: boolean;
	project?: string;
	includeArchived?: boolean;
}

export async function convPrdList(options: ConvPrdListOptions): Promise<void> {
	const params: string[] = [];
	if (options.project) params.push(`projectPath=${encodeURIComponent(options.project)}`);
	if (options.includeArchived) params.push(`includeArchived=true`);
	const qs = params.length ? `?${params.join('&')}` : '';

	let result: ConvPrdApiResult<ConvPrdSessionSummary[]>;
	try {
		result = await convPrdFetch<ConvPrdSessionSummary[]>(`/sessions${qs}`);
	} catch (err) {
		exitWithError(err instanceof Error ? err.message : String(err), options.json);
	}

	if (!result.success) {
		exitWithError((result as ConvPrdApiError).error ?? 'Unknown error from Maestro', options.json, {
			code: (result as ConvPrdApiError).code,
		});
	}

	const sessions = (result as ConvPrdApiOk<ConvPrdSessionSummary[]>).data;

	if (options.json) {
		console.log(JSON.stringify(sessions, null, 2));
		return;
	}

	if (!sessions || sessions.length === 0) {
		console.log('No Conversational PRD sessions found.');
		return;
	}

	const idWidth = 12;
	const statusWidth = 12;
	const titleWidth = 45;

	const header = ['ID'.padEnd(idWidth), 'STATUS'.padEnd(statusWidth), 'TITLE'].join('  ');
	const divider = '-'.repeat(idWidth + statusWidth + titleWidth + 4);

	console.log('\nConversational PRD Sessions\n');
	console.log(header);
	console.log(divider);

	for (const s of sessions) {
		const shortId = s.id.slice(0, idWidth - 1).padEnd(idWidth);
		const status = (s.status ?? '').padEnd(statusWidth);
		const title = (s.metadata?.title ?? s.draft?.title ?? '(no title)').slice(0, titleWidth);
		console.log(`${shortId}  ${status}  ${title}`);
	}

	console.log(`\n${sessions.length} session${sessions.length !== 1 ? 's' : ''}`);
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

export interface ConvPrdStartOptions {
	initial?: string;
	project?: string;
	json?: boolean;
}

export async function convPrdStart(options: ConvPrdStartOptions): Promise<void> {
	const body: Record<string, unknown> = {
		actor: { type: 'user', id: 'cli', name: 'CLI' },
	};
	if (options.initial) body.initialContent = options.initial;
	if (options.project) body.projectPath = options.project;

	let result: ConvPrdApiResult<ConvPrdSessionSummary>;
	try {
		result = await convPrdFetch<ConvPrdSessionSummary>('/sessions', {
			method: 'POST',
			body: JSON.stringify(body),
		});
	} catch (err) {
		exitWithError(err instanceof Error ? err.message : String(err), options.json);
	}

	if (!result.success) {
		exitWithError((result as ConvPrdApiError).error ?? 'Failed to start session', options.json, {
			code: (result as ConvPrdApiError).code,
		});
	}

	const session = (result as ConvPrdApiOk<ConvPrdSessionSummary>).data;

	if (options.json) {
		console.log(JSON.stringify({ sessionId: session.id, session }, null, 2));
		return;
	}

	console.log(`Session started: ${session.id}`);
	if (session.metadata?.title) console.log(`  Title:   ${session.metadata.title}`);
	if (session.metadata?.projectPath) console.log(`  Project: ${session.metadata.projectPath}`);
	console.log(`  Status:  ${session.status ?? 'active'}`);
	console.log(`\nNext: maestro-cli conv-prd ask ${session.id} "Your question"`);
}

// ---------------------------------------------------------------------------
// ask
// ---------------------------------------------------------------------------

export interface ConvPrdAskOptions {
	json?: boolean;
}

export async function convPrdAsk(
	sessionId: string,
	message: string,
	options: ConvPrdAskOptions
): Promise<void> {
	if (!sessionId) {
		exitWithError('sessionId argument is required', options.json);
	}
	if (!message) {
		exitWithError('message argument is required', options.json);
	}

	const body = {
		sessionId,
		message,
		actor: { type: 'user', id: 'cli', name: 'CLI' },
	};

	let result: ConvPrdApiResult<{ reply?: string; assistantMessage?: string; draft?: unknown }>;
	try {
		result = await convPrdFetch<{ reply?: string; assistantMessage?: string; draft?: unknown }>(
			`/sessions/${encodeURIComponent(sessionId)}/messages`,
			{
				method: 'POST',
				body: JSON.stringify(body),
			}
		);
	} catch (err) {
		exitWithError(err instanceof Error ? err.message : String(err), options.json);
	}

	if (!result.success) {
		exitWithError((result as ConvPrdApiError).error ?? 'Failed to send message', options.json, {
			code: (result as ConvPrdApiError).code,
		});
	}

	const data = (
		result as ConvPrdApiOk<{ reply?: string; assistantMessage?: string; draft?: unknown }>
	).data;

	if (options.json) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}

	const reply = data?.reply ?? data?.assistantMessage;
	if (reply) {
		console.log('\nAssistant:\n');
		console.log(reply);
	} else {
		console.log(JSON.stringify(data, null, 2));
	}
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

export interface ConvPrdShowOptions {
	json?: boolean;
}

export async function convPrdShow(sessionId: string, options: ConvPrdShowOptions): Promise<void> {
	if (!sessionId) {
		exitWithError('sessionId argument is required', options.json);
	}

	let result: ConvPrdApiResult<ConvPrdSessionSummary>;
	try {
		result = await convPrdFetch<ConvPrdSessionSummary>(
			`/sessions/${encodeURIComponent(sessionId)}`
		);
	} catch (err) {
		exitWithError(err instanceof Error ? err.message : String(err), options.json);
	}

	if (!result.success) {
		exitWithError((result as ConvPrdApiError).error ?? 'Session not found', options.json, {
			code: (result as ConvPrdApiError).code,
		});
	}

	const session = (result as ConvPrdApiOk<ConvPrdSessionSummary>).data;

	if (options.json) {
		console.log(JSON.stringify(session, null, 2));
		return;
	}

	console.log(`\nSession: ${session.id}`);
	console.log(`  Status:  ${session.status ?? 'unknown'}`);
	if (session.metadata?.title) console.log(`  Title:   ${session.metadata.title}`);
	if (session.metadata?.projectPath) console.log(`  Project: ${session.metadata.projectPath}`);
	if (session.draft?.title) console.log(`  Draft title: ${session.draft.title}`);
	if (session.draft?.summary) console.log(`  Draft summary: ${session.draft.summary}`);

	const messages = session.messages ?? [];
	if (messages.length > 0) {
		console.log(`\n  Messages (${messages.length}):`);
		for (const msg of messages) {
			const prefix = msg.role === 'user' ? '  User:      ' : '  Assistant: ';
			const snippet = String(msg.content ?? '')
				.slice(0, 120)
				.replace(/\n/g, ' ');
			console.log(`${prefix}${snippet}${String(msg.content ?? '').length > 120 ? '…' : ''}`);
		}
	}
}

// ---------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------

export interface ConvPrdFinalizeOptions {
	handoffToPlanner?: boolean;
	json?: boolean;
}

export async function convPrdFinalize(
	sessionId: string,
	options: ConvPrdFinalizeOptions
): Promise<void> {
	if (!sessionId) {
		exitWithError('sessionId argument is required', options.json);
	}

	const body: Record<string, unknown> = {
		sessionId,
		actor: { type: 'user', id: 'cli', name: 'CLI' },
	};
	if (options.handoffToPlanner) {
		body.handoffToPlanner = true;
	}

	let result: ConvPrdApiResult<unknown>;
	try {
		result = await convPrdFetch<unknown>(`/sessions/${encodeURIComponent(sessionId)}/finalize`, {
			method: 'POST',
			body: JSON.stringify(body),
		});
	} catch (err) {
		exitWithError(err instanceof Error ? err.message : String(err), options.json);
	}

	if (!result.success) {
		exitWithError((result as ConvPrdApiError).error ?? 'Finalize failed', options.json, {
			code: (result as ConvPrdApiError).code,
		});
	}

	const data = (result as ConvPrdApiOk<unknown>).data;

	if (options.json) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}

	const finalized = data as {
		session?: { status?: string };
		prdWorkItem?: { id?: string; title?: string };
		prdId?: string;
	};

	console.log(`Session ${sessionId} finalized.`);
	if (finalized?.session?.status) console.log(`  Status: ${finalized.session.status}`);

	const prdItem = finalized?.prdWorkItem;
	const prdId = prdItem?.id ?? finalized?.prdId;
	if (prdId) {
		console.log(`  PRD work item: ${prdId}`);
		if (prdItem?.title) console.log(`  PRD title:    ${prdItem.title}`);
		if (options.handoffToPlanner) {
			console.log(`\nHandoff complete. Run: maestro-cli planner prd decompose ${prdId}`);
		}
	}
}

// ---------------------------------------------------------------------------
// archive
// ---------------------------------------------------------------------------

export interface ConvPrdArchiveOptions {
	json?: boolean;
}

export async function convPrdArchive(
	sessionId: string,
	options: ConvPrdArchiveOptions
): Promise<void> {
	if (!sessionId) {
		exitWithError('sessionId argument is required', options.json);
	}

	const body = {
		sessionId,
		actor: { type: 'user', id: 'cli', name: 'CLI' },
	};

	let result: ConvPrdApiResult<unknown>;
	try {
		result = await convPrdFetch<unknown>(`/sessions/${encodeURIComponent(sessionId)}`, {
			method: 'DELETE',
			body: JSON.stringify(body),
		});
	} catch (err) {
		exitWithError(err instanceof Error ? err.message : String(err), options.json);
	}

	if (!result.success) {
		exitWithError((result as ConvPrdApiError).error ?? 'Archive failed', options.json, {
			code: (result as ConvPrdApiError).code,
		});
	}

	const data = (result as ConvPrdApiOk<unknown>).data;

	if (options.json) {
		console.log(JSON.stringify(data, null, 2));
		return;
	}

	console.log(`Session ${sessionId} archived.`);
}
