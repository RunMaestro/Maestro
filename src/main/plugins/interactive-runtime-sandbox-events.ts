import type { PanelErrorCode } from '../../shared/plugins/interactive-panel';
import type {
	InteractiveRuntimeHandle,
	RuntimeEvent,
	RuntimeMessage,
} from '../../shared/plugins/interactive-runtime';

export type InteractiveRuntimeEventDto = {
	readonly runtimeId: string;
	readonly generation: string;
	readonly event:
		| { readonly kind: 'started'; readonly sequence: string }
		| { readonly kind: 'exit'; readonly sequence: string; readonly code: number | null }
		| { readonly kind: 'safe_error'; readonly sequence: string; readonly class: PanelErrorCode };
};

export interface InteractiveRuntimeMessageDto {
	readonly runtimeId: string;
	readonly generation: string;
	readonly message: RuntimeMessage;
}

/** Structural boundary keeps this generic event bridge independent of Electron. */
export interface SandboxRuntimeEventSink {
	pushEvent(
		pluginId: string,
		event: { readonly topic: string; readonly at: string; readonly payload: unknown }
	): boolean;
}

interface ForwardedRuntime {
	readonly ownerPluginId: string;
	readonly generation: bigint;
	readonly handle: InteractiveRuntimeHandle;
	unsubscribeEvent: () => void;
	unsubscribeMessage: () => void;
}

const MAX_RUNTIME_PAYLOAD_BYTES = 64 * 1024;
const MAX_RUNTIME_ID_LENGTH = 256;
const PANEL_ERROR_CODES = new Set<PanelErrorCode>([
	'backpressure',
	'invalid_request',
	'capability_unavailable',
	'policy_denied',
	'runtime_stopped',
	'timeout',
	'cancelled',
]);

/**
 * Routes host-owned runtime outputs to exactly the sandbox generation that
 * created the handle. Runtime ids are never accepted from plugin code.
 */
export class InteractiveRuntimeSandboxEventForwarder {
	private readonly runtimes = new Map<string, ForwardedRuntime>();

	constructor(private readonly sink: SandboxRuntimeEventSink) {}

	attach(ownerPluginId: string, generation: bigint, handle: InteractiveRuntimeHandle): boolean {
		if (
			!isValidOwner(ownerPluginId) ||
			!isValidRuntimeId(handle.runtimeId) ||
			handle.generation !== generation
		) {
			return false;
		}
		this.detachAny(handle.runtimeId);
		const record: ForwardedRuntime = {
			ownerPluginId,
			generation,
			handle,
			unsubscribeEvent: () => undefined,
			unsubscribeMessage: () => undefined,
		};
		this.runtimes.set(handle.runtimeId, record);
		try {
			record.unsubscribeEvent = handle.onEvent((event) => this.forwardEvent(record, event));
			record.unsubscribeMessage = handle.onMessage((message) =>
				this.forwardMessage(record, message)
			);
			return true;
		} catch {
			this.runtimes.delete(handle.runtimeId);
			try {
				record.unsubscribeEvent();
			} catch {
				// A half-attached listener must never escape as an active route.
			}
			return false;
		}
	}

	/** Unsubscribe a single current owner/generation before stopping its handle. */
	detach(
		ownerPluginId: string,
		runtimeId: string,
		generation: bigint
	): InteractiveRuntimeHandle | null {
		const record = this.runtimes.get(runtimeId);
		if (!record || record.ownerPluginId !== ownerPluginId || record.generation !== generation) {
			return null;
		}
		this.runtimes.delete(runtimeId);
		try {
			record.unsubscribeEvent();
		} catch {
			// Subscription cleanup must not prevent the enclosing stop/revoke.
		}
		try {
			record.unsubscribeMessage();
		} catch {
			// Subscription cleanup must not prevent the enclosing stop/revoke.
		}
		return record.handle;
	}

	/** Unsubscribe every runtime for this owner before its capability is revoked. */
	revokeOwner(ownerPluginId: string): void {
		for (const [runtimeId, record] of this.runtimes) {
			if (record.ownerPluginId === ownerPluginId) {
				this.detach(ownerPluginId, runtimeId, record.generation);
			}
		}
	}

	private detachAny(runtimeId: string): void {
		const record = this.runtimes.get(runtimeId);
		if (record) this.detach(record.ownerPluginId, runtimeId, record.generation);
	}

	private forwardEvent(record: ForwardedRuntime, event: RuntimeEvent): void {
		if (this.runtimes.get(record.handle.runtimeId) !== record) return;
		const dto = toRuntimeEventDto(record.handle.runtimeId, record.generation, event);
		if (!dto) return;
		this.push(record.ownerPluginId, `__interactiveRuntimeEvent:${dto.runtimeId}`, dto);
	}

	private forwardMessage(record: ForwardedRuntime, message: RuntimeMessage): void {
		if (this.runtimes.get(record.handle.runtimeId) !== record) return;
		const dto = toRuntimeMessageDto(record.handle.runtimeId, record.generation, message);
		if (!dto) return;
		this.push(record.ownerPluginId, `__interactiveRuntimeMessage:${dto.runtimeId}`, dto);
	}

	private push(ownerPluginId: string, topic: string, payload: unknown): void {
		try {
			this.sink.pushEvent(ownerPluginId, { topic, at: new Date().toISOString(), payload });
		} catch {
			// A dead sandbox cannot be allowed to crash its shared runtime process.
		}
	}
}

function toRuntimeEventDto(
	runtimeId: string,
	generation: bigint,
	event: RuntimeEvent
): InteractiveRuntimeEventDto | null {
	if (generation < 0n || !isValidRuntimeId(runtimeId) || event.sequence < 0n) return null;
	let normalized: InteractiveRuntimeEventDto['event'];
	if (event.kind === 'started') {
		normalized = { kind: 'started', sequence: event.sequence.toString(10) };
	} else if (event.kind === 'exit') {
		if (event.code !== null && !Number.isSafeInteger(event.code)) return null;
		normalized = { kind: 'exit', sequence: event.sequence.toString(10), code: event.code };
	} else if (event.kind === 'safe_error' && PANEL_ERROR_CODES.has(event.class)) {
		normalized = { kind: 'safe_error', sequence: event.sequence.toString(10), class: event.class };
	} else {
		return null;
	}
	const dto: InteractiveRuntimeEventDto = {
		runtimeId,
		generation: generation.toString(10),
		event: normalized,
	};
	return withinBudget(dto) ? dto : null;
}

function toRuntimeMessageDto(
	runtimeId: string,
	generation: bigint,
	message: RuntimeMessage
): InteractiveRuntimeMessageDto | null {
	if (
		generation < 0n ||
		!isValidRuntimeId(runtimeId) ||
		!Number.isSafeInteger(message.sequence) ||
		message.sequence <= 0
	) {
		return null;
	}
	const dto: InteractiveRuntimeMessageDto = {
		runtimeId,
		generation: generation.toString(10),
		message,
	};
	return withinBudget(dto) ? dto : null;
}

function withinBudget(payload: unknown): boolean {
	try {
		return JSON.stringify(payload).length <= MAX_RUNTIME_PAYLOAD_BYTES;
	} catch {
		return false;
	}
}

function isValidRuntimeId(runtimeId: string): boolean {
	return (
		typeof runtimeId === 'string' &&
		runtimeId.length > 0 &&
		runtimeId.length <= MAX_RUNTIME_ID_LENGTH
	);
}

function isValidOwner(ownerPluginId: string): boolean {
	return (
		typeof ownerPluginId === 'string' &&
		ownerPluginId.length > 0 &&
		ownerPluginId.length <= MAX_RUNTIME_ID_LENGTH
	);
}
