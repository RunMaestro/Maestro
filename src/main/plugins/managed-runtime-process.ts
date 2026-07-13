import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';

import type { JsonValue, PanelErrorCode } from '../../shared/plugins/interactive-panel';
import {
	MAX_INTERACTIVE_RUNTIME_INPUT_FRAME_BYTES,
	MAX_INTERACTIVE_RUNTIME_OUTPUT_FRAME_BYTES,
	type InteractiveStopReason,
	type RuntimeEvent,
	type RuntimeMessage,
} from '../../shared/plugins/interactive-runtime';

const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_FRAMES_PER_WINDOW = 128;
const RATE_WINDOW_MS = 1_000;
const STOP_GRACE_MS = 1_000;
const MAX_PRE_LISTENER_MESSAGES = 64;
const MAX_PRE_LISTENER_MESSAGE_BYTES = MAX_INTERACTIVE_RUNTIME_OUTPUT_FRAME_BYTES;

export interface ManagedRuntimeWritable {
	write(data: string): boolean;
	writableLength?: number;
	on(event: 'drain', listener: () => void): unknown;
}

export interface ManagedRuntimeReadable {
	on(event: 'data', listener: (data: Uint8Array | string) => void): unknown;
}

export interface ManagedRuntimeChild {
	readonly pid?: number;
	readonly stdin?: ManagedRuntimeWritable | null;
	readonly stdout?: ManagedRuntimeReadable | null;
	readonly stderr?: ManagedRuntimeReadable | null;
	exitCode?: number | null;
	on(event: 'exit', listener: (code: number | null) => void): unknown;
	on(event: 'error', listener: () => void): unknown;
	kill(signal?: NodeJS.Signals): boolean;
}

export interface ManagedRuntimeLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly shell: false;
	readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
}

export type ProcessTreeKiller = (pid: number, force: boolean) => Promise<void>;

export interface ManagedRuntimeProcessOptions {
	readonly child: ManagedRuntimeChild;
	readonly killTree: ProcessTreeKiller;
	readonly now?: () => number;
	readonly stopGraceMs?: number;
}

/**
 * Owns untrusted child stdio. Its only outward operations are canonical JSONL
 * requests and bounded lifecycle events; raw streams and process handles remain
 * private to main.
 */
export class ManagedRuntimeProcess {
	private readonly listeners = new Set<(event: RuntimeEvent) => void>();
	private readonly messageListeners = new Set<(message: RuntimeMessage) => void>();
	private readonly now: () => number;
	private readonly stopGraceMs: number;
	private stdoutBuffer = Buffer.alloc(0);
	private stderrBuffer = Buffer.alloc(0);
	private sequence = 0n;
	private messageSequence = 0;
	private readonly startedEvent: Extract<RuntimeEvent, { kind: 'started' }>;
	private closed = false;
	private acceptingWrites = true;
	private stopping: Promise<void> | undefined;
	private windowStartedAt = 0;
	private framesInWindow = 0;
	private preListenerMessages: RuntimeMessage[] = [];
	private preListenerMessageBytes = 0;
	private firstMessageListenerInstalled = false;

	constructor(private readonly options: ManagedRuntimeProcessOptions) {
		this.now = options.now ?? Date.now;
		this.stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS;
		options.child.stdout?.on('data', (data) => this.consume(data, false));
		options.child.stderr?.on('data', (data) => this.consume(data, true));
		options.child.on('exit', (code) => this.onExit(code));
		options.child.on('error', () => this.fail('runtime_stopped'));
		this.startedEvent = { kind: 'started', sequence: this.nextSequence() };
		this.emit(this.startedEvent);
	}

	onEvent(listener: (event: RuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		try {
			listener(this.startedEvent);
		} catch {
			// A lifecycle observer cannot crash the runtime process.
		}
		return () => this.listeners.delete(listener);
	}

	onMessage(listener: (message: RuntimeMessage) => void): () => void {
		this.messageListeners.add(listener);
		if (!this.firstMessageListenerInstalled) {
			this.firstMessageListenerInstalled = true;
			const queued = this.preListenerMessages;
			this.preListenerMessages = [];
			this.preListenerMessageBytes = 0;
			for (const message of queued) this.notifyMessage(listener, message);
		}
		return () => this.messageListeners.delete(listener);
	}

	async writeCanonicalJson(value: JsonValue): Promise<void> {
		if (this.closed || !this.acceptingWrites) throw new Error('runtime is closed');
		const encoded = `${canonicalJson(value)}\n`;
		if (Buffer.byteLength(encoded) > MAX_INTERACTIVE_RUNTIME_INPUT_FRAME_BYTES) {
			throw new Error('runtime input frame exceeds the maximum size');
		}
		const stdin = this.options.child.stdin;
		if (!stdin) {
			this.fail('runtime_stopped');
			throw new Error('runtime stdin is unavailable');
		}
		if (stdin.writableLength !== undefined && stdin.writableLength > MAX_BUFFER_BYTES) {
			this.fail('backpressure');
			throw new Error('runtime input backpressure limit exceeded');
		}
		if (!stdin.write(encoded)) {
			await once(stdin as never, 'drain');
			if (this.closed || !this.acceptingWrites) throw new Error('runtime is closed');
		}
	}

	stop(_reason: InteractiveStopReason): Promise<void> {
		this.clearPreListenerMessages();
		if (this.stopping) return this.stopping;
		this.stopping = this.stopInternal();
		return this.stopping;
	}

	private consume(data: Uint8Array | string, stderr: boolean): void {
		if (this.closed) return;
		if (stderr) {
			// stderr is diagnostics only: it is bounded independently and never
			// interpreted as runtime protocol, even when it resembles JSON.
			const next = Buffer.concat([this.stderrBuffer, Buffer.from(data)]);
			this.stderrBuffer =
				next.length <= MAX_BUFFER_BYTES ? next : next.subarray(next.length - MAX_BUFFER_BYTES);
			return;
		}
		const next = Buffer.concat([this.stdoutBuffer, Buffer.from(data)]);
		if (next.length > MAX_BUFFER_BYTES) {
			this.fail('backpressure');
			return;
		}
		let buffer = next;
		let newline = buffer.indexOf(10);
		while (newline >= 0) {
			const line = buffer.subarray(0, newline);
			buffer = buffer.subarray(newline + 1);
			if (line.length > MAX_INTERACTIVE_RUNTIME_OUTPUT_FRAME_BYTES) {
				this.fail('invalid_request');
				return;
			}
			if (line.length > 0 && !this.acceptFrame(line)) return;
			newline = buffer.indexOf(10);
		}
		if (buffer.length > MAX_INTERACTIVE_RUNTIME_OUTPUT_FRAME_BYTES) {
			this.fail('invalid_request');
			return;
		}
		this.stdoutBuffer = buffer;
	}

	private acceptFrame(line: Buffer): boolean {
		const now = this.now();
		if (now - this.windowStartedAt >= RATE_WINDOW_MS) {
			this.windowStartedAt = now;
			this.framesInWindow = 0;
		}
		this.framesInWindow += 1;
		if (this.framesInWindow > MAX_FRAMES_PER_WINDOW) {
			this.fail('backpressure');
			return false;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line.toString('utf8').replace(/\r$/, ''));
		} catch {
			this.fail('invalid_request');
			return false;
		}
		if (!isJsonValue(parsed) || this.messageSequence >= Number.MAX_SAFE_INTEGER) {
			this.fail('invalid_request');
			return false;
		}
		this.messageSequence += 1;
		this.emitMessage({
			sequence: this.messageSequence,
			value: deepFreezeJson(parsed),
		});
		return true;
	}

	private async stopInternal(): Promise<void> {
		if (this.closed) return;
		const pid = this.options.child.pid;
		try {
			if (pid && pid > 0) await this.options.killTree(pid, false);
			else this.options.child.kill('SIGTERM');
		} catch {
			// A process may have exited between capability resolution and stop.
		}
		await new Promise<void>((resolve) => setTimeout(resolve, this.stopGraceMs));
		if (!this.closed && this.options.child.exitCode === null) {
			try {
				if (pid && pid > 0) await this.options.killTree(pid, true);
				else this.options.child.kill('SIGKILL');
			} catch {
				// The close event remains authoritative; failure to signal cannot leak a handle.
			}
		}
		if (!this.closed) this.onExit(this.options.child.exitCode ?? null);
	}

	private fail(errorClass: PanelErrorCode): void {
		if (this.closed || !this.acceptingWrites) return;
		this.acceptingWrites = false;
		this.emit({ kind: 'safe_error', sequence: this.nextSequence(), class: errorClass });
		void this.stop('revoked');
	}

	private onExit(code: number | null): void {
		if (this.closed) return;
		this.closed = true;
		this.clearPreListenerMessages();
		this.emit({ kind: 'exit', sequence: this.nextSequence(), code });
	}

	private emit(event: RuntimeEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// Listener failures must not corrupt the owned runtime lifecycle.
			}
		}
	}

	private emitMessage(message: RuntimeMessage): void {
		if (!this.firstMessageListenerInstalled) {
			let encodedBytes: number;
			try {
				encodedBytes = Buffer.byteLength(JSON.stringify(message));
			} catch {
				this.fail('invalid_request');
				return;
			}
			if (
				this.preListenerMessages.length >= MAX_PRE_LISTENER_MESSAGES ||
				this.preListenerMessageBytes + encodedBytes > MAX_PRE_LISTENER_MESSAGE_BYTES
			) {
				this.fail('backpressure');
				return;
			}
			this.preListenerMessages.push(message);
			this.preListenerMessageBytes += encodedBytes;
			return;
		}
		for (const listener of this.messageListeners) this.notifyMessage(listener, message);
	}

	private notifyMessage(
		listener: (message: RuntimeMessage) => void,
		message: RuntimeMessage
	): void {
		try {
			listener(message);
		} catch {
			// A consumer cannot crash the runtime process with a callback fault.
		}
	}

	private clearPreListenerMessages(): void {
		this.preListenerMessages = [];
		this.preListenerMessageBytes = 0;
	}

	private nextSequence(): bigint {
		this.sequence += 1n;
		return this.sequence;
	}
}

export const defaultProcessTreeKiller: ProcessTreeKiller = async (pid, force) => {
	if (process.platform === 'win32') {
		await promisify(execFile)('taskkill', ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])]);
		return;
	}
	try {
		process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
	} catch {
		process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
	}
};

function canonicalJson(value: JsonValue): string {
	if (!isJsonValue(value)) throw new Error('runtime request must be JSON');
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (!isJsonObject(value)) throw new Error('runtime request must be a JSON object');
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
		.join(',')}}`;
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value !== 'object') return false;
	return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function deepFreezeJson(value: JsonValue): JsonValue {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) {
		for (const item of value) deepFreezeJson(item);
		return Object.freeze(value);
	}
	for (const child of Object.values(value)) deepFreezeJson(child);
	return Object.freeze(value);
}
