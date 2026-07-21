/**
 * Tests for TTSR edit/write snapshot extraction across the per-agent tool
 * event shapes described by Gate A.
 */

import { describe, it, expect } from 'vitest';
import {
	extractEditSnapshots,
	extractPatchAdditions,
	extractPatchPath,
} from '../../../main/ttsr/ttsr-tool-extract';
import type { ParsedEvent } from '../../../main/parsers/agent-output-parser';

describe('extractEditSnapshots', () => {
	it('extracts a claude-code Write block', () => {
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [
				{ name: 'Write', id: 't1', input: { file_path: 'src/a.ts', content: 'const a = 1;' } },
			],
		};

		expect(extractEditSnapshots(event)).toEqual([
			{ source: 'tool:write', toolName: 'Write', filePath: 'src/a.ts', content: 'const a = 1;' },
		]);
	});

	it('extracts a claude-code Edit replacement string', () => {
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [
				{ name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } },
			],
		};

		expect(extractEditSnapshots(event)[0]).toMatchObject({
			source: 'tool:edit',
			content: 'b',
		});
	});

	it('concatenates every replacement in a MultiEdit', () => {
		const event: ParsedEvent = {
			type: 'tool_use',
			toolUseBlocks: [
				{
					name: 'MultiEdit',
					input: {
						file_path: 'src/a.ts',
						edits: [{ new_string: 'first' }, { new_string: 'second' }, { bogus: true }],
					},
				},
			],
		};

		expect(extractEditSnapshots(event)[0].content).toBe('first\nsecond');
	});

	it('extracts an opencode toolState write', () => {
		const event: ParsedEvent = {
			type: 'tool_use',
			toolName: 'write',
			toolState: { status: 'running', input: { filePath: 'src/b.ts', content: 'x' } },
		};

		expect(extractEditSnapshots(event)).toEqual([
			{ source: 'tool:write', toolName: 'write', filePath: 'src/b.ts', content: 'x' },
		]);
	});

	it('recovers added lines and the path from a codex apply_patch', () => {
		const patch = [
			'*** Begin Patch',
			'*** Update File: src/c.ts',
			'@@',
			'-const old = 1;',
			'+const next = 2;',
			' unchanged',
			'*** End Patch',
		].join('\n');
		const event: ParsedEvent = {
			type: 'tool_use',
			toolName: 'apply_patch',
			toolState: { status: 'running', input: patch },
		};

		expect(extractEditSnapshots(event)).toEqual([
			{
				source: 'tool:edit',
				toolName: 'apply_patch',
				filePath: 'src/c.ts',
				content: 'const next = 2;',
			},
		]);
	});

	it('ignores non-mutating tools and payloads with no content', () => {
		expect(
			extractEditSnapshots({
				type: 'tool_use',
				toolUseBlocks: [{ name: 'Read', input: { file_path: 'src/a.ts' } }],
			})
		).toEqual([]);
		expect(
			extractEditSnapshots({
				type: 'tool_use',
				toolUseBlocks: [{ name: 'Write', input: { file_path: 'src/a.ts' } }],
			})
		).toEqual([]);
		expect(extractEditSnapshots({ type: 'text', text: 'hi' })).toEqual([]);
	});
});

describe('patch helpers', () => {
	it('keeps added lines and drops the +++ header', () => {
		expect(extractPatchAdditions('--- a/x\n+++ b/x\n@@\n+added\n-removed')).toBe('added');
	});

	it('reads the path from a unified diff header when no apply_patch header exists', () => {
		expect(extractPatchPath('--- a/src/x.ts\n+++ b/src/x.ts\n@@\n+a')).toBe('src/x.ts');
		expect(extractPatchPath('no headers here')).toBeUndefined();
	});
});
