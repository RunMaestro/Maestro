import { OMP_RPC_VERSION } from './types';
import type { OmpRpcCommand, OmpRpcEvent, OmpRpcResponse, OmpRpcTransport } from './types';

export class OmpProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OmpProtocolError';
	}
}

interface PendingRequest {
	command: string;
	resolve: (response: OmpRpcResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class OmpRpcClient {
	private readonly pending = new Map<string, PendingRequest>();
	private readonly events = new Set<(event: OmpRpcEvent) => void>();
	private readonly diagnostics = new Set<(message: string) => void>();
	private readonly callbacks = new Set<(event: OmpRpcEvent) => void>();
	private readonly readyPromise: Promise<void>;
	private resolveReady!: () => void;
	private rejectReady!: (reason: Error) => void;
	private sequence = 0;
	private request = 0;
	private closed = false;
	private buffer = '';

	constructor(
		private readonly transport: OmpRpcTransport,
		private readonly timeoutMs = 15_000
	) {
		this.readyPromise = new Promise<void>((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
		transport.onFrame((chunk) => this.receive(chunk));
		transport.onDiagnostic((chunk) => {
			const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
			for (const listener of this.diagnostics) listener(text);
		});
		transport.onClosed((reason) => this.close(reason));
	}

	get ready(): Promise<void> {
		return this.readyPromise;
	}

	onEvent(listener: (event: OmpRpcEvent) => void): () => void {
		this.events.add(listener);
		return () => this.events.delete(listener);
	}

	onCallback(listener: (event: OmpRpcEvent) => void): () => void {
		this.callbacks.add(listener);
		return () => this.callbacks.delete(listener);
	}

	onDiagnostic(listener: (message: string) => void): () => void {
		this.diagnostics.add(listener);
		return () => this.diagnostics.delete(listener);
	}

	async command(command: OmpRpcCommand): Promise<OmpRpcResponse> {
		await this.ready;
		if (this.closed) throw new OmpProtocolError('OMP RPC process is closed');
		const id = `maestro-omp-${++this.request}`;
		return new Promise<OmpRpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new OmpProtocolError(`OMP command ${command.type} timed out`));
			}, this.timeoutMs);
			this.pending.set(id, { command: command.type, resolve, reject, timer });
			Promise.resolve(this.transport.send(`${JSON.stringify({ ...command, id })}\n`)).catch(
				(error) => {
					const pending = this.pending.get(id);
					if (!pending) return;
					this.pending.delete(id);
					clearTimeout(pending.timer);
					pending.reject(
						error instanceof Error ? error : new OmpProtocolError('OMP stdin write failed')
					);
				}
			);
		});
	}

	async send(callback: OmpRpcCommand): Promise<void> {
		await this.ready;
		await this.transport.send(`${JSON.stringify(callback)}\n`);
	}

	private receive(chunk: Uint8Array | string): void {
		this.buffer += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
		let newline = this.buffer.indexOf('\n');
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line) this.dispatch(line);
			newline = this.buffer.indexOf('\n');
		}
	}

	private dispatch(line: string): void {
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(line) as Record<string, unknown>;
		} catch {
			this.close('OMP emitted malformed JSONL');
			return;
		}
		if (frame.type === 'ready') {
			if (frame.version && frame.version !== OMP_RPC_VERSION) {
				this.close(`OMP protocol ${String(frame.version)} is unsupported`);
				return;
			}
			this.resolveReady();
			return;
		}
		if (
			frame.type === 'response' &&
			typeof frame.id === 'string' &&
			typeof frame.command === 'string'
		) {
			const pending = this.pending.get(frame.id);
			if (!pending) return;
			this.pending.delete(frame.id);
			clearTimeout(pending.timer);
			if (frame.success === true) {
				pending.resolve({
					type: 'response',
					id: frame.id,
					command: frame.command,
					success: true,
					...('data' in frame ? { data: frame.data } : {}),
				});
			} else
				pending.reject(
					new OmpProtocolError(
						typeof frame.error === 'string' ? frame.error : `OMP command ${pending.command} failed`
					)
				);
			return;
		}
		if (typeof frame.type !== 'string') return;
		const event = frame as OmpRpcEvent;
		if (typeof event.sequence === 'number') {
			if (event.sequence <= this.sequence) return;
			this.sequence = event.sequence;
		}
		const listeners =
			event.type === 'extension_ui_request' ||
			event.type === 'prompt_result' ||
			event.type === 'available_commands_update' ||
			event.type.startsWith('subagent_')
				? this.callbacks
				: this.events;
		for (const listener of listeners) listener(event);
	}

	private close(reason?: string): void {
		if (this.closed) return;
		this.closed = true;
		const error = new OmpProtocolError(reason ?? 'OMP RPC process closed');
		this.rejectReady(error);
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			clearTimeout(pending.timer);
			pending.reject(error);
		}
	}
}
