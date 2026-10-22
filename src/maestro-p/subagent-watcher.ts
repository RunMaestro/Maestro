// Subagent transcripts, so a Task call's inner work reaches the caller.
//
// `claude -p` streams a subagent's messages inline, each tagged with
// `parent_tool_use_id` (the id of the Task call that started it). The TUI writes
// them to their own files instead, beside the session transcript:
//
//   <project>/<session-id>/subagents/agent-<agent-id>.jsonl
//   <project>/<session-id>/subagents/agent-<agent-id>.meta.json  { toolUseId, ... }
//
// so tailing the session transcript alone showed a Task call and then nothing
// until its result, however long it ran. This watches that folder, links each
// file to its Task call through the meta file, and hands every row on with the
// call's id. A nested subagent's meta names the Task call inside its parent
// subagent, which is the same id `claude -p` would put on it.

import { EventEmitter } from 'node:events';
import * as fs from 'fs';
import * as path from 'path';
import { JsonlTailer, type ParseErrorPayload } from './jsonl-tailer';

const DEFAULT_POLL_INTERVAL_MS = 250;
// The meta file is written as the subagent starts and its transcript follows
// with the first row, but a subagent queued behind others can start late.
const TRANSCRIPT_WAIT_MS = 10 * 60 * 1000;
const META_SUFFIX = '.meta.json';

export interface SubagentWatcherOptions {
	/** The session transcript path; subagents live in `<path without .jsonl>/subagents`. */
	sessionTranscriptPath: string;
	pollIntervalMs?: number;
}

export type SubagentWatcherEvent = 'entry' | 'parse-error';

/** Whether a message's content holds a block of this type. */
export function hasBlockOfType(message: unknown, type: string): boolean {
	if (!message || typeof message !== 'object') return false;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	return content.some((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === type);
}

export interface ForwardedMessage {
	type: 'assistant' | 'user';
	message: Record<string, unknown>;
}

/**
 * Which subagent rows reach the caller, matching what `claude -p` streams
 * (measured against claude 2.1.296): the prompt the Task call handed over, the
 * subagent's tool calls, and their results. Its text is not streamed, neither
 * the narration between calls nor the final answer, which reaches the main
 * thread as the Task call's result. Forwarding that text would also put it in
 * the caller's reply buffer as if the main thread had said it.
 */
export class SubagentStream {
	private readonly promptsSent = new Set<string>();

	forward(entry: unknown, parentToolUseId: string): ForwardedMessage | null {
		if (!entry || typeof entry !== 'object') return null;
		const row = entry as Record<string, unknown>;
		const message = row.message as Record<string, unknown> | undefined;
		if (!message || message.model === '<synthetic>') return null;
		if (row.type === 'assistant') {
			return hasBlockOfType(message, 'tool_use') ? { type: 'assistant', message } : null;
		}
		if (row.type !== 'user' || row.isMeta === true) return null;
		if (hasBlockOfType(message, 'tool_result')) return { type: 'user', message };
		// The first plain user row is the prompt. The transcript stores it as a
		// string; `claude -p` sends a text block.
		if (this.promptsSent.has(parentToolUseId)) return null;
		this.promptsSent.add(parentToolUseId);
		const content =
			typeof message.content === 'string'
				? [{ type: 'text', text: message.content }]
				: message.content;
		return { type: 'user', message: { ...message, content } };
	}
}

/** Where a session's subagent transcripts are written. */
export function subagentsDir(sessionTranscriptPath: string): string {
	return path.join(sessionTranscriptPath.replace(/\.jsonl$/, ''), 'subagents');
}

/** The Task call a subagent belongs to, read from its meta file, or null. */
export function readSubagentToolUseId(metaPath: string): string | null {
	try {
		const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as { toolUseId?: unknown };
		return typeof meta.toolUseId === 'string' && meta.toolUseId ? meta.toolUseId : null;
	} catch {
		// Not written in full yet, or not JSON: try again on the next poll.
		return null;
	}
}

export class SubagentWatcher extends EventEmitter {
	private readonly dir: string;
	private readonly pollIntervalMs: number;
	/** Meta files already handled, or present before this turn started. */
	private readonly seen = new Set<string>();
	private readonly tailers: JsonlTailer[] = [];
	private pollTimer: NodeJS.Timeout | null = null;
	private stopped = false;

	constructor(options: SubagentWatcherOptions) {
		super();
		this.dir = subagentsDir(options.sessionTranscriptPath);
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	}

	/**
	 * Start watching. Subagents an earlier turn of a resumed session started are
	 * skipped: their rows were that turn's output, not this one's.
	 */
	start(): void {
		for (const name of this.listMetaFiles()) this.seen.add(name);
		this.schedule();
	}

	/** Newest time any subagent transcript grew, or 0 when none has. */
	getLastByteAt(): number {
		let latest = 0;
		for (const tailer of this.tailers) latest = Math.max(latest, tailer.getLastByteAt());
		return latest;
	}

	/** Read whatever the subagent transcripts hold right now. */
	drain(): void {
		for (const tailer of this.tailers) tailer.drain();
	}

	stop(): void {
		this.stopped = true;
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
		for (const tailer of this.tailers) tailer.stop();
	}

	private schedule(): void {
		if (this.stopped) return;
		this.pollTimer = setTimeout(() => {
			this.pollTimer = null;
			this.poll();
			this.schedule();
		}, this.pollIntervalMs);
	}

	private poll(): void {
		for (const name of this.listMetaFiles()) {
			if (this.seen.has(name)) continue;
			const toolUseId = readSubagentToolUseId(path.join(this.dir, name));
			if (toolUseId === null) continue;
			this.seen.add(name);
			this.follow(path.join(this.dir, `${name.slice(0, -META_SUFFIX.length)}.jsonl`), toolUseId);
		}
	}

	private follow(transcriptPath: string, toolUseId: string): void {
		const tailer = new JsonlTailer({
			path: transcriptPath,
			skipExisting: false,
			existsTimeoutMs: TRANSCRIPT_WAIT_MS,
		});
		tailer.on('entry', (entry: unknown) => this.emit('entry', entry, toolUseId));
		tailer.on('parse-error', (payload: ParseErrorPayload) => this.emit('parse-error', payload));
		this.tailers.push(tailer);
		tailer.start().catch(() => {
			// The subagent never wrote a transcript; there is nothing to forward.
		});
	}

	private listMetaFiles(): string[] {
		try {
			return fs.readdirSync(this.dir).filter((name) => name.endsWith(META_SUFFIX));
		} catch {
			// No subagent has run in this session yet.
			return [];
		}
	}
}
