/**
 * The panel's only future runtime boundary. WorkspaceRpcTransport will bind the
 * host-issued global to this exact closed request/event vocabulary; presentation
 * code never reads Electron, raw IPC, window.maestro, or postMessage directly.
 */
export type OmpPanelRequestKind =
	| 'omp.workspace.snapshot'
	| 'omp.session.select'
	| 'omp.session.create'
	| 'omp.message.send'
	| 'omp.session.abort'
	| 'omp.session.set-model'
	| 'omp.session.set-mode'
	| 'omp.approval.resolve'
	| 'omp.workspace.retry';

export type OmpPanelEventKind = 'omp.workspace.snapshot';

export interface OmpPanelPort {
	request(kind: OmpPanelRequestKind, payload: Record<string, unknown>): Promise<unknown>;
	subscribe(kind: OmpPanelEventKind, listener: (payload: unknown) => void): () => void;
}
