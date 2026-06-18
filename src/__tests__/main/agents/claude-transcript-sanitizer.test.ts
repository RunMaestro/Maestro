/**
 * Tests for src/main/agents/claude-transcript-sanitizer.ts
 *
 * Mirrors the real failure shape: maestro-p interactive turns persist thinking
 * blocks as signature-only shells (empty `thinking` text + a signature). The
 * sanitizer must remove them so the transcript resumes cleanly under the API
 * token source, while preserving the parentUuid threading and all non-thinking
 * content.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { stripThinkingFromTranscript } from '../../../main/agents/claude-transcript-sanitizer';

let dir: string;
let transcriptPath: string;

function write(rows: unknown[]): void {
	fs.writeFileSync(transcriptPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function readRows(): Array<Record<string, unknown>> {
	return fs
		.readFileSync(transcriptPath, 'utf8')
		.split('\n')
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l));
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-sanitize-'));
	transcriptPath = path.join(dir, 'session.jsonl');
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('stripThinkingFromTranscript', () => {
	it('drops thinking-only assistant rows and re-links the parentUuid chain', () => {
		write([
			{ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' } },
			{
				type: 'assistant',
				uuid: 'a1',
				parentUuid: 'u1',
				message: {
					role: 'assistant',
					content: [{ type: 'thinking', thinking: '', signature: 'sig-abc' }],
				},
			},
			{
				type: 'assistant',
				uuid: 'a2',
				parentUuid: 'a1',
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'hello there' }],
				},
			},
		]);

		const res = stripThinkingFromTranscript(transcriptPath);

		expect(res.sanitized).toBe(true);
		expect(res.droppedRows).toBe(1);
		expect(res.strippedBlocks).toBe(0);

		const rows = readRows();
		expect(rows.map((r) => r.uuid)).toEqual(['u1', 'a2']);
		// a2 was re-linked past the dropped a1 to a1's parent (u1).
		expect(rows.find((r) => r.uuid === 'a2')?.parentUuid).toBe('u1');
	});

	it('re-links transitively across consecutive dropped rows', () => {
		write([
			{ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'go' } },
			{
				type: 'assistant',
				uuid: 't1',
				parentUuid: 'u1',
				message: {
					role: 'assistant',
					content: [{ type: 'thinking', thinking: '', signature: 's1' }],
				},
			},
			{
				type: 'assistant',
				uuid: 't2',
				parentUuid: 't1',
				message: {
					role: 'assistant',
					content: [{ type: 'thinking', thinking: '', signature: 's2' }],
				},
			},
			{ type: 'attachment', uuid: 'att', parentUuid: 't2' },
		]);

		const res = stripThinkingFromTranscript(transcriptPath);

		expect(res.droppedRows).toBe(2);
		const rows = readRows();
		expect(rows.map((r) => r.uuid)).toEqual(['u1', 'att']);
		expect(rows.find((r) => r.uuid === 'att')?.parentUuid).toBe('u1');
	});

	it('strips thinking blocks from a mixed-content row without dropping it', () => {
		write([
			{
				type: 'assistant',
				uuid: 'a1',
				parentUuid: null,
				message: {
					role: 'assistant',
					content: [
						{ type: 'thinking', thinking: '', signature: 'sig' },
						{ type: 'text', text: 'visible' },
						{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} },
					],
				},
			},
		]);

		const res = stripThinkingFromTranscript(transcriptPath);

		expect(res.sanitized).toBe(true);
		expect(res.droppedRows).toBe(0);
		expect(res.strippedBlocks).toBe(1);

		const content = (readRows()[0].message as { content: Array<{ type: string }> }).content;
		expect(content.map((b) => b.type)).toEqual(['text', 'tool_use']);
	});

	it('is a no-op when there are no thinking blocks (byte-identical, no backup)', () => {
		write([
			{ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' } },
			{
				type: 'assistant',
				uuid: 'a1',
				parentUuid: 'u1',
				message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }] },
			},
		]);
		const before = fs.readFileSync(transcriptPath, 'utf8');

		const res = stripThinkingFromTranscript(transcriptPath);

		expect(res.sanitized).toBe(false);
		expect(res.backupPath).toBeNull();
		expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(before);
		expect(fs.existsSync(`${transcriptPath}.maestro-presanitize.bak`)).toBe(false);
	});

	it('writes a one-time backup of the original before mutating', () => {
		write([
			{
				type: 'assistant',
				uuid: 'a1',
				parentUuid: null,
				message: {
					role: 'assistant',
					content: [{ type: 'thinking', thinking: '', signature: 's' }],
				},
			},
		]);
		const original = fs.readFileSync(transcriptPath, 'utf8');

		const res = stripThinkingFromTranscript(transcriptPath);

		expect(res.backupPath).toBe(`${transcriptPath}.maestro-presanitize.bak`);
		expect(fs.readFileSync(res.backupPath as string, 'utf8')).toBe(original);
	});

	it('preserves malformed (non-JSON) lines verbatim', () => {
		fs.writeFileSync(
			transcriptPath,
			[
				JSON.stringify({
					type: 'assistant',
					uuid: 'a1',
					parentUuid: null,
					message: {
						role: 'assistant',
						content: [{ type: 'thinking', thinking: '', signature: 's' }],
					},
				}),
				'{ not valid json',
				JSON.stringify({
					type: 'assistant',
					uuid: 'a2',
					parentUuid: 'a1',
					message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
				}),
			].join('\n') + '\n',
			'utf8'
		);

		stripThinkingFromTranscript(transcriptPath);

		const out = fs.readFileSync(transcriptPath, 'utf8');
		expect(out).toContain('{ not valid json');
		const rows = out
			.split('\n')
			.filter((l) => l.trim().length > 0 && l.trim().startsWith('{"'))
			.map((l) => JSON.parse(l));
		expect(rows.map((r) => r.uuid)).toEqual(['a2']);
	});

	it('returns a no-op for a missing file', () => {
		const res = stripThinkingFromTranscript(path.join(dir, 'does-not-exist.jsonl'));
		expect(res.sanitized).toBe(false);
		expect(res.droppedRows).toBe(0);
	});

	it('preserves valid API-account thinking blocks (non-empty reasoning text)', () => {
		// Pure-API transcripts: the sanitizer must NOT strip thinking blocks
		// that carry non-empty reasoning. Anthropic's API rejects re-resumes
		// where the latest assistant message's thinking blocks were modified,
		// so stripping them would itself trip the 400 we're trying to prevent.
		write([
			{ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' } },
			{
				type: 'assistant',
				uuid: 'a1',
				parentUuid: 'u1',
				message: {
					role: 'assistant',
					content: [
						{ type: 'thinking', thinking: 'Let me consider this.', signature: 'api-sig' },
						{ type: 'text', text: 'sure' },
					],
				},
			},
		]);
		const before = fs.readFileSync(transcriptPath, 'utf8');

		const res = stripThinkingFromTranscript(transcriptPath);

		expect(res.sanitized).toBe(false);
		expect(res.strippedBlocks).toBe(0);
		expect(res.droppedRows).toBe(0);
		expect(res.backupPath).toBeNull();
		expect(fs.readFileSync(transcriptPath, 'utf8')).toBe(before);
	});

	it('strips empty shells while preserving non-empty thinking siblings in the same message', () => {
		// Hybrid shape: a single assistant message carrying both a maestro-p
		// shell and a valid API-account thinking block. Only the shell is
		// removed; the signed reasoning block survives untouched.
		write([
			{
				type: 'assistant',
				uuid: 'a1',
				parentUuid: null,
				message: {
					role: 'assistant',
					content: [
						{ type: 'thinking', thinking: '', signature: 'maestro-p-sig' },
						{ type: 'thinking', thinking: 'real reasoning', signature: 'api-sig' },
						{ type: 'text', text: 'answer' },
					],
				},
			},
		]);

		const res = stripThinkingFromTranscript(transcriptPath);

		expect(res.sanitized).toBe(true);
		expect(res.droppedRows).toBe(0);
		expect(res.strippedBlocks).toBe(1);

		const content = (
			readRows()[0].message as { content: Array<{ type: string; thinking?: string }> }
		).content;
		expect(content.map((b) => b.type)).toEqual(['thinking', 'text']);
		expect(content[0].thinking).toBe('real reasoning');
	});

	it('treats `redacted_thinking` without a thinking field as an empty shell', () => {
		// `redacted_thinking` blocks may legitimately omit `thinking`; they
		// only carry an account-bound signature, so they're stripped just like
		// the empty-string shells maestro-p writes.
		write([
			{
				type: 'assistant',
				uuid: 'a1',
				parentUuid: null,
				message: {
					role: 'assistant',
					content: [
						{ type: 'redacted_thinking', signature: 'sig' },
						{ type: 'text', text: 'visible' },
					],
				},
			},
		]);

		const res = stripThinkingFromTranscript(transcriptPath);

		expect(res.sanitized).toBe(true);
		expect(res.strippedBlocks).toBe(1);
		const content = (readRows()[0].message as { content: Array<{ type: string }> }).content;
		expect(content.map((b) => b.type)).toEqual(['text']);
	});
});
