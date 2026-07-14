export const OMP_RPC_VERSION = '16.4.8' as const;

export interface OmpRpcCommand {
	id?: string;
	type: string;
	[key: string]: unknown;
}

export interface OmpRpcResponse {
	type: 'response';
	id: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

export interface OmpRpcEvent {
	type: string;
	sequence?: number;
	[key: string]: unknown;
}

export interface OmpRpcTransport {
	send(frame: string): void | Promise<void>;
	onFrame(listener: (chunk: Uint8Array | string) => void): () => void;
	onDiagnostic(listener: (chunk: Uint8Array | string) => void): () => void;
	onClosed(listener: (reason?: string) => void): () => void;
}
