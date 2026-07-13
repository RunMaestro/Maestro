import type { OmpPanelEventKind, OmpPanelRequestKind } from '../bridge/descriptor';
import type { OmpComposerMode, OmpWorkspaceAdapter, OmpWorkspaceSnapshot } from './types';

export type { OmpPanelEventKind, OmpPanelRequestKind } from '../bridge/descriptor';

export interface OmpPanelResult {
	kind: OmpPanelRequestKind;
	requestId: string;
	payload: unknown;
}

export interface OmpPanelEvent {
	kind: OmpPanelEventKind;
	eventSequence: bigint;
	payload: unknown;
}

/**
 * The panel's only runtime boundary. The host owns capability, instance, and
 * correlation routing; panel callers can issue only descriptor-declared kinds.
 */
export interface OmpPanelPort {
	request(kind: OmpPanelRequestKind, payload: Record<string, unknown>): Promise<OmpPanelResult>;
	subscribe(kind: OmpPanelEventKind, listener: (event: OmpPanelEvent) => void): () => void;
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

/** Adapts the frozen panel port to the workspace's intentionally narrow UI API. */
export function createOmpWorkspaceAdapter(port: OmpPanelPort): OmpWorkspaceAdapter {
	return {
		async getSnapshot() {
			const payload = await request(port, 'omp.workspace.snapshot', {});
			if (!isWorkspaceSnapshot(payload))
				throw new Error('OMP returned an invalid workspace snapshot.');
			return payload;
		},
		subscribe(listener) {
			return port.subscribe('omp.workspace.snapshot', (event) => {
				if (isWorkspaceSnapshot(event.payload)) listener(event.payload);
			});
		},
		async selectSession(sessionId) {
			await request(port, 'omp.session.select', { sessionId });
		},
		async createSession() {
			await request(port, 'omp.session.create', {});
		},
		async sendMessage(sessionId, text, attachments) {
			await request(port, 'omp.message.send', {
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
			await request(port, 'omp.session.abort', { sessionId });
		},
		async setModel(sessionId, model) {
			await request(port, 'omp.session.set-model', { sessionId, model });
		},
		async setMode(sessionId, mode: OmpComposerMode) {
			await request(port, 'omp.session.set-mode', { sessionId, mode });
		},
		async resolveApproval(sessionId, requestId, approved) {
			await request(port, 'omp.approval.resolve', { sessionId, requestId, approved });
		},
		async retry() {
			await request(port, 'omp.workspace.retry', {});
		},
	};
}
