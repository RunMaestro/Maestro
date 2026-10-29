import type { CodexMemorySourceRef } from './codexMemory';
import type { CustomAICommand } from './customAICommands';

/** Transient host UI input. Main-process authorization is still required before generation. */
export interface MemoryCommandSnapshot {
	sourceRef: CodexMemorySourceRef;
	textSnapshot: string;
	dirty: boolean;
	selection?: { start: number; end: number };
}

export interface MemoryCommandSelection extends MemoryCommandSnapshot {
	requestId: string;
	status: 'selected';
	generator: { agentId: string; provider: 'codex'; model: string; effort: string };
}

export const MEMORY_COMMAND_MAX_BYTES = 128 * 1024;

export interface MemoryCommandDraft {
	command: string;
	description: string;
	prompt: string;
}

/** Transient handoff to the existing global create form. */
export interface MemoryCommandPreview {
	requestId: string;
	draft: MemoryCommandDraft;
}

/** Host-issued editor identity delegates one CLI request to the native command form. */
export interface MemoryCommandEditorPreview extends MemoryCommandPreview {
	viewerId: string;
	background: boolean;
}

export interface MemoryCommandDraftStatus {
	requestId: string;
	status:
		| 'selected'
		| 'generating'
		| 'ready'
		| 'preview'
		| 'saving'
		| 'saved'
		| 'cancelled'
		| 'error';
}

export type MemoryCommandSaveResult =
	| { requestId: string; status: 'saved'; commands: CustomAICommand[] }
	| { requestId: string; status: 'retry' | 'collision' };

export interface SelectedMemoryCommandSnapshot {
	requestId: string;
	sourceRef: CodexMemorySourceRef;
	text: string;
	dirty: boolean;
	generatorAgentId: string;
}

/** Closed JSON objects at the memory-command boundary, not a general schema library. */
function fields(
	value: unknown,
	required: string[],
	optional: string[] = []
): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
		Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
	);
}

function boundedString(value: unknown, max = 4096): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/** The renderer and main validate the same text and UTF-16 offsets before copying or slicing. */
export function validateMemoryCommandSnapshot(snapshot: MemoryCommandSnapshot): void {
	if (
		!fields(snapshot, ['sourceRef', 'textSnapshot', 'dirty'], ['selection']) ||
		!fields(snapshot.sourceRef, [
			'sourceAgentId',
			'provider',
			'location',
			'codexHome',
			'memoryRoot',
			'relativePath',
		]) ||
		snapshot.sourceRef.provider !== 'codex' ||
		!boundedString(snapshot.sourceRef.sourceAgentId) ||
		!fields(snapshot.sourceRef.location, ['kind']) ||
		snapshot.sourceRef.location.kind !== 'local' ||
		!boundedString(snapshot.sourceRef.codexHome) ||
		!boundedString(snapshot.sourceRef.memoryRoot) ||
		!boundedString(snapshot.sourceRef.relativePath) ||
		typeof snapshot.dirty !== 'boolean' ||
		typeof snapshot.textSnapshot !== 'string'
	) {
		throw new Error('Invalid Codex memory snapshot');
	}
	if (
		snapshot.textSnapshot.length > MEMORY_COMMAND_MAX_BYTES ||
		new TextEncoder().encode(snapshot.textSnapshot).byteLength > MEMORY_COMMAND_MAX_BYTES
	) {
		throw new Error('Memory snapshot exceeds 128 KiB');
	}
	const selection = snapshot.selection;
	if (selection !== undefined) {
		if (!fields(selection, ['start', 'end'])) throw new Error('Invalid memory snapshot selection');
		const { start, end } = selection;
		const text = snapshot.textSnapshot;
		const splitsSurrogate = (offset: number) =>
			offset > 0 &&
			offset < text.length &&
			/[\uD800-\uDBFF]/.test(text[offset - 1]) &&
			/[\uDC00-\uDFFF]/.test(text[offset]);
		if (
			!Number.isInteger(start) ||
			!Number.isInteger(end) ||
			start < 0 ||
			end < start ||
			end > text.length ||
			splitsSurrogate(start) ||
			splitsSurrogate(end)
		) {
			throw new Error('Invalid memory snapshot selection');
		}
	}
}

/** Validate the renderer's provisional selection; its ID and execution hints confer no authority. */
export function validateMemoryCommandSelection(
	value: unknown
): asserts value is MemoryCommandSelection {
	if (
		!fields(
			value,
			['sourceRef', 'textSnapshot', 'dirty', 'requestId', 'status', 'generator'],
			['selection']
		) ||
		!boundedString(value.requestId) ||
		value.status !== 'selected' ||
		!fields(value.generator, ['agentId', 'provider', 'model', 'effort']) ||
		!boundedString(value.generator.agentId) ||
		value.generator.provider !== 'codex' ||
		typeof value.generator.model !== 'string' ||
		value.generator.model.length > 4096 ||
		typeof value.generator.effort !== 'string' ||
		value.generator.effort.length > 4096
	) {
		throw new Error('Invalid memory command selection');
	}
	validateMemoryCommandSnapshot({
		sourceRef: value.sourceRef,
		textSnapshot: value.textSnapshot,
		dirty: value.dirty,
		selection: value.selection,
	} as MemoryCommandSnapshot);
}

/** Keep the existing command spelling; the global editor adds its existing leading slash on save. */
export function isMemoryCommandDraft(value: unknown): value is MemoryCommandDraft {
	return (
		fields(value, ['command', 'description', 'prompt']) &&
		boundedString(value.command, 256) &&
		boundedString(value.description) &&
		boundedString(value.prompt, MEMORY_COMMAND_MAX_BYTES) &&
		new TextEncoder().encode(value.prompt).byteLength <= MEMORY_COMMAND_MAX_BYTES
	);
}

/** Parse the provider envelope only after bounding the entire response, including whitespace. */
export function parseMemoryCommandDraftResponse(response: unknown): MemoryCommandDraft {
	if (
		typeof response !== 'string' ||
		response.length > MEMORY_COMMAND_MAX_BYTES ||
		new TextEncoder().encode(response).byteLength > MEMORY_COMMAND_MAX_BYTES
	)
		throw new Error('MemoryCommandInvalid');
	try {
		const parsed: unknown = JSON.parse(response);
		if (!fields(parsed, ['draft']) || !isMemoryCommandDraft(parsed.draft))
			throw new Error('MemoryCommandInvalid');
		return { ...parsed.draft };
	} catch {
		throw new Error('MemoryCommandInvalid');
	}
}

/** Local CLI secret authenticates the host; viewerId separates concurrent CLI workflows. */
export type MemoryCommandCliRequest =
	| { action: 'select'; viewerId: string; selection: unknown }
	| {
			action: 'generate' | 'status' | 'cancel' | 'preview';
			viewerId: string;
			draftRequestId: string;
			background?: boolean;
			editor?: boolean;
	  }
	| { action: 'save'; viewerId: string; draftRequestId: string; draft: unknown };
