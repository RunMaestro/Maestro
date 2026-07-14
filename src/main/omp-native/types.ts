export const OMP_RPC_VERSION = '16.4.8' as const;

export const OMP_IMAGE_MEDIA_TYPES = [
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
] as const;

export type OmpImageMediaType = (typeof OMP_IMAGE_MEDIA_TYPES)[number];

/** Exact image envelope accepted by the OMP 16.4.8 `prompt` RPC command. */
export interface OmpRpcImage {
	image: {
		data: string;
		mimeType: OmpImageMediaType;
	};
}

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
