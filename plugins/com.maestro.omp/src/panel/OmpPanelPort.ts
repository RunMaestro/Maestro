import type { OmpPanelEventKind, OmpPanelRequestKind } from '../bridge/descriptor';
import type { OmpWorkspaceAdapter, OmpWorkspaceSnapshot } from './types';

export type { OmpPanelEventKind, OmpPanelRequestKind } from '../bridge/descriptor';

export interface OmpPanelResult {
	readonly kind: OmpPanelRequestKind;
	readonly requestId: string;
	readonly payload: unknown;
}

export interface OmpPanelEvent {
	readonly kind: OmpPanelEventKind;
	readonly eventSequence: bigint;
	readonly payload: unknown;
}

/** The panel's generation-capability-bound API; it never exposes raw runtime frames. */
export interface OmpPanelPort {
	request(kind: OmpPanelRequestKind, payload: Record<string, unknown>): Promise<OmpPanelResult>;
	subscribe(kind: OmpPanelEventKind, listener: (event: OmpPanelEvent) => void): () => void;
}

export class OmpPanelCapabilityUnavailableError extends Error {
	readonly code = 'capability_unavailable';

	constructor(control: string) {
		super(`OMP control ${control} is unavailable in this runtime.`);
		this.name = 'OmpPanelCapabilityUnavailableError';
	}
}

export interface OmpPanelControllerAdapter {
	request(kind: OmpPanelRequestKind, payload: Record<string, unknown>): Promise<unknown>;
	subscribe(kind: OmpPanelEventKind, listener: (payload: unknown) => void): () => void;
}

function isWorkspaceSnapshot(value: unknown): value is OmpWorkspaceSnapshot {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const snapshot = value as Record<string, unknown>;
	return (
		(snapshot.connection === 'loading' ||
			snapshot.connection === 'ready' ||
			snapshot.connection === 'offline' ||
			snapshot.connection === 'incompatible' ||
			snapshot.connection === 'error') &&
		Array.isArray(snapshot.models) &&
		Array.isArray(snapshot.sessions) &&
		(typeof snapshot.activeSessionId === 'string' || snapshot.activeSessionId === null)
	);
}

async function request(
	port: OmpPanelPort,
	kind: OmpPanelRequestKind,
	payload: Record<string, unknown>
): Promise<unknown> {
	const result = await port.request(kind, payload);
	if (result.kind !== kind) throw new Error(`OMP panel received ${result.kind} for ${kind}.`);
	return result.payload;
}

/** Exposes all frozen named controls while keeping presentation callers off a generic transport. */
export function createOmpPanelControllerAdapter(port: OmpPanelPort): OmpPanelControllerAdapter {
	return {
		request: (kind, payload) => request(port, kind, payload),
		subscribe: (kind, listener) => port.subscribe(kind, (event) => listener(event.payload)),
	};
}

/**
 * Compatibility view used by the current presentation tree. Legacy UI concepts that
 * have no §4.2 command intentionally reject with a typed visible-unavailable error.
 */
export function createOmpWorkspaceAdapter(port: OmpPanelPort): OmpWorkspaceAdapter {
	const controller = createOmpPanelControllerAdapter(port);
	return {
		async getSnapshot() {
			const payload = await controller.request('omp.commands.refresh', {});
			if (!isWorkspaceSnapshot(payload))
				throw new Error('OMP returned an invalid workspace projection.');
			return payload;
		},
		subscribe(listener) {
			return controller.subscribe('omp.view.replace', (payload) => {
				if (isWorkspaceSnapshot(payload)) listener(payload);
			});
		},
		async selectSession(sessionId) {
			await controller.request('omp.session.select', { sessionId });
		},
		async createSession() {
			await controller.request('omp.session.create', {});
		},
		async sendMessage(sessionId, text, attachments) {
			await controller.request('omp.prompt.send', {
				sessionId,
				text,
				attachments: attachments.map((attachment) => ({
					name: attachment.name,
					mediaType: attachment.type,
					size: attachment.size,
				})),
			});
		},
		async abort(sessionId) {
			await controller.request('omp.run.abort', { sessionId });
		},
		async setModel(sessionId, model) {
			const separator = model.indexOf('/');
			if (separator <= 0 || separator === model.length - 1)
				throw new OmpPanelCapabilityUnavailableError('omp.model.set');
			await controller.request('omp.model.set', {
				sessionId,
				provider: model.slice(0, separator),
				modelId: model.slice(separator + 1),
			});
		},
		async setMode() {
			throw new OmpPanelCapabilityUnavailableError('composer mode');
		},
		async resolveApproval() {
			throw new OmpPanelCapabilityUnavailableError('approval resolution');
		},
		async retry() {
			await controller.request('omp.commands.refresh', {});
		},
	};
}
