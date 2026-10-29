import { describe, expect, it } from 'vitest';
import {
	selectMemoryCommandDraft,
	previewMemoryCommandDraft,
} from '../../../renderer/services/memoryCommandDraft';
import type { MemoryCommandSnapshot } from '../../../shared/memoryCommandDraft';

const source: MemoryCommandSnapshot = {
	sourceRef: {
		sourceAgentId: 'source',
		provider: 'codex',
		location: { kind: 'local' },
		codexHome: '/synthetic',
		memoryRoot: '/synthetic/memories',
		relativePath: 'MEMORY.md',
	},
	textSnapshot: 'a\r\n😀b',
	dirty: false,
	selection: { start: 3, end: 5 },
};
const generator = {
	agentId: 'generator',
	provider: 'codex' as const,
	model: 'synthetic',
	effort: 'medium',
};

describe('memory command selection', () => {
	it('captures detached input and distinct request IDs without modifying source or generator', () => {
		const snapshot = structuredClone(source);
		const result = selectMemoryCommandDraft(snapshot, generator);
		expect(result.status).toBe('selected');
		expect(result.textSnapshot.slice(result.selection!.start, result.selection!.end)).toBe('😀');
		expect(result.requestId).not.toBe(selectMemoryCommandDraft(source, generator).requestId);
		snapshot.sourceRef.relativePath = 'changed.md';
		snapshot.selection!.start = 0;
		expect(result.sourceRef.relativePath).toBe('MEMORY.md');
		expect(result.selection).toEqual({ start: 3, end: 5 });
		expect(generator.agentId).toBe('generator');
	});
	it.each([
		{ start: -1, end: 1 },
		{ start: 0, end: 20 },
		{ start: 4, end: 5 },
		{ start: 5, end: 4 },
		{ start: 0.5, end: 1 },
	])('rejects invalid UTF-16 range %j', (selection) => {
		expect(() => selectMemoryCommandDraft({ ...source, selection }, generator)).toThrow(
			'Invalid memory snapshot selection'
		);
	});
	it('uses the whole exact file for empty selection and measures the limit in UTF-8 bytes', () => {
		expect(
			selectMemoryCommandDraft({ ...source, selection: { start: 3, end: 3 } }, generator).selection
		).toBeUndefined();
		expect(
			selectMemoryCommandDraft(
				{ ...source, textSnapshot: 'é'.repeat(65536), selection: undefined },
				generator
			).textSnapshot.length
		).toBe(65536);
		expect(() =>
			selectMemoryCommandDraft(
				{ ...source, textSnapshot: 'é'.repeat(65537), selection: undefined },
				generator
			)
		).toThrow('128 KiB');
	});
});

describe('transient command preview', () => {
	it('validates and detaches draft fields without changing source or writing settings', () => {
		const draft = {
			command: 'synthetic',
			description: 'Synthetic command',
			prompt: 'Synthetic prompt',
		};
		const before = JSON.stringify(source);
		const preview = previewMemoryCommandDraft('host-request', draft);
		draft.prompt = 'changed';
		expect(preview).toEqual({
			requestId: 'host-request',
			draft: { command: 'synthetic', description: 'Synthetic command', prompt: 'Synthetic prompt' },
		});
		expect(JSON.stringify(source)).toBe(before);
	});
	it.each([
		null,
		{},
		{ command: 'bad', description: 'bad', prompt: '' },
		{ command: 'bad', description: 'bad', prompt: 'bad', scope: 'project' },
	])('rejects an invalid preview %j', (draft) => {
		expect(() => previewMemoryCommandDraft('host-request', draft)).toThrow(
			'Invalid command preview'
		);
	});
});
