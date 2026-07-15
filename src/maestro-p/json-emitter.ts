// Stream-json emitter for maestro-p.
//
// Serializes the four-event protocol Maestro's existing claude-output-parser
// already understands:
//
//   { type: 'system',    subtype: 'init', session_id, model, cwd }
//   { type: 'assistant', message }                          // verbatim from JSONL
//   { type: 'user',      message }                          // verbatim, tool_result only
//   { type: 'result',    subtype, session_id, duration_ms, is_error, ... }
//
// Plus a single-shot `status` event for --status mode.
//
// Pass-through, not re-synthesis
// ------------------------------
// `assistant` / `user` messages take the original JSONL `.message` object and
// wrap it verbatim under our envelope shape. We do not reshape content blocks,
// filter fields, or re-aggregate usage. The structured JSONL transcript IS
// our source of truth (see MAESTRO-P-01-binary.md "Architectural Lessons #1");
// this emitter exists only to translate envelope shapes, not contents.
//
// State machine
// -------------
// `init` is one-shot - second and subsequent emitInit() calls are a silent
// no-op (callers that retry on race shouldn't crash). The terminal events
// (`emitResult`, `emitStatus`) are also one-shot; once either has fired, ALL
// subsequent emit calls throw. assistant/user emissions before init or after
// the terminal also throw - these are programmer errors that would corrupt
// the wire protocol if allowed through.

export interface EmitInitOptions {
	sessionId: string;
	model: string | null;
	cwd: string;
}

export interface EmitResultOptions {
	sessionId: string;
	durationMs: number;
	isError: boolean;
	error?: string;
	result?: string;
	usage?: unknown;
	modelUsage?: unknown;
	totalCostUsd?: number;
}

// The /usage parser produces this shape and emitStatus() ships it to stdout
// verbatim. Defined here so json-emitter.ts owns the wire-format contract;
// usage-parser.ts imports from this module.
//
// `auth_state` distinguishes a real measurement from the "Not logged in"
// stub. When `unauthenticated`, the percent / resets_at fields are placeholder
// zeros - Claude's `/usage` panel for an unauthenticated config dir is the
// API-billing variant ($0.00 across the board), which carries no real Max
// plan signal. Downstream consumers (dashboard, mode selector) key off
// `auth_state` to decide whether the numbers mean anything.
//
// Older callers can omit `auth_state` entirely; readers MUST treat its
// absence as `'authenticated'` so on-disk snapshots written before this
// field existed keep deserializing into the live UI.
export interface StatusSnapshot {
	type: 'status';
	auth_state?: 'authenticated' | 'unauthenticated';
	config_dir: string;
	session: { percent: number; resets_at: string };
	week_all_models: { percent: number; resets_at: string };
	week_sonnet_only: { percent: number; resets_at: string };
}

export class JsonEmitter {
	private initEmitted = false;
	private finalEmitted = false;

	emitInit(options: EmitInitOptions): void {
		if (this.finalEmitted) {
			throw new Error('JsonEmitter: emitInit() called after final envelope');
		}
		if (this.initEmitted) {
			// Idempotent on duplicate init: the runner may race the discovery
			// path against a fast-arriving JSONL line and we don't want a
			// second emit to corrupt the stream.
			return;
		}
		this.initEmitted = true;
		this.writeLine({
			type: 'system',
			subtype: 'init',
			session_id: options.sessionId,
			model: options.model,
			cwd: options.cwd,
		});
	}

	emitAssistantMessage(message: unknown): void {
		this.requireInitOpen('emitAssistantMessage');
		this.writeLine({ type: 'assistant', message });
	}

	emitUserMessage(message: unknown): void {
		this.requireInitOpen('emitUserMessage');
		this.writeLine({ type: 'user', message });
	}

	emitResult(options: EmitResultOptions): void {
		if (!this.initEmitted) {
			throw new Error('JsonEmitter: emitResult() called before emitInit()');
		}
		if (this.finalEmitted) {
			throw new Error('JsonEmitter: emitResult() called after final envelope');
		}
		this.finalEmitted = true;
		const envelope: Record<string, unknown> = {
			type: 'result',
			subtype: options.isError ? 'error_during_execution' : 'success',
			session_id: options.sessionId,
			duration_ms: options.durationMs,
			is_error: options.isError,
		};
		// Optional fields are emitted only when supplied so callers can omit
		// them on error paths without polluting the envelope with `null`s.
		if (options.error !== undefined) envelope.error = options.error;
		if (options.result !== undefined) envelope.result = options.result;
		if (options.usage !== undefined) envelope.usage = options.usage;
		if (options.modelUsage !== undefined) envelope.modelUsage = options.modelUsage;
		if (options.totalCostUsd !== undefined) envelope.total_cost_usd = options.totalCostUsd;
		this.writeLine(envelope);
	}

	emitStatus(snapshot: StatusSnapshot): void {
		if (this.finalEmitted) {
			throw new Error('JsonEmitter: emitStatus() called after final envelope');
		}
		// `--status` mode is a standalone single-line protocol - init is
		// intentionally NOT required (and would be wrong, since status mode
		// never spawns a Claude session id at the wire level).
		this.finalEmitted = true;
		this.writeLine(snapshot);
	}

	private requireInitOpen(methodName: string): void {
		// Final check comes first: once the protocol is closed (result or
		// status fired), any further emission is a wire-format bug regardless
		// of whether init was ever called. Reporting "after final" surfaces
		// the more useful root cause in that case.
		if (this.finalEmitted) {
			throw new Error(`JsonEmitter: ${methodName}() called after final envelope`);
		}
		if (!this.initEmitted) {
			throw new Error(`JsonEmitter: ${methodName}() called before emitInit()`);
		}
	}

	private writeLine(obj: unknown): void {
		try {
			process.stdout.write(`${JSON.stringify(obj)}\n`);
		} catch (err) {
			// The desktop (our stdout reader) can disappear mid-turn - the user
			// interrupts, closes the tab, or the process is killed. The next write
			// then fails with EPIPE, which Node surfaces synchronously here. There is
			// nothing left to emit to, so swallow it instead of crashing maestro-p
			// (under ELECTRON_RUN_AS_NODE an uncaught throw pops Electron's GUI error
			// dialog). Re-throw anything that isn't a dead-pipe condition.
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== 'EPIPE' && code !== 'ERR_STREAM_DESTROYED') {
				throw err;
			}
		}
	}
}
