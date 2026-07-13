export interface OmpAttachmentDto {
	readonly name: string;
	readonly mediaType: string;
	readonly size: number;
	readonly bytes: ArrayBuffer;
}

/** Main-only seam implemented by the OMP runtime owner; never exposed to IPC. */
export interface OmpWorkspaceFacade<Snapshot> {
	getSnapshot(): Promise<Snapshot>;
	subscribe(listener: (snapshot: Snapshot) => void): () => void;
	selectSession(sessionId: string): Promise<void>;
	createSession(): Promise<void>;
	sendMessage(
		sessionId: string,
		text: string,
		attachments: readonly OmpAttachmentDto[]
	): Promise<void>;
	abort(sessionId: string): Promise<void>;
	setModel(sessionId: string, model: string): Promise<void>;
	setMode(sessionId: string, mode: string): Promise<void>;
	resolveApproval(sessionId: string, requestId: string, approved: boolean): Promise<void>;
	retry(): Promise<void>;
}

export const MAX_OMP_ATTACHMENTS = 8;
export const MAX_OMP_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_OMP_MESSAGE_CHARS = 64 * 1024;

export function assertOmpAttachmentDtos(
	value: unknown
): asserts value is readonly OmpAttachmentDto[] {
	if (!Array.isArray(value) || value.length > MAX_OMP_ATTACHMENTS)
		throw new Error('InvalidOmpAttachments');
	for (const attachment of value) {
		if (typeof attachment !== 'object' || attachment === null)
			throw new Error('InvalidOmpAttachments');
		const item = attachment as Record<string, unknown>;
		if (
			typeof item.name !== 'string' ||
			item.name.length === 0 ||
			item.name.length > 256 ||
			typeof item.mediaType !== 'string' ||
			item.mediaType.length === 0 ||
			item.mediaType.length > 128 ||
			!Number.isSafeInteger(item.size) ||
			(item.size as number) < 0 ||
			(item.size as number) > MAX_OMP_ATTACHMENT_BYTES ||
			!(item.bytes instanceof ArrayBuffer) ||
			item.bytes.byteLength !== item.size
		)
			throw new Error('InvalidOmpAttachments');
	}
}
