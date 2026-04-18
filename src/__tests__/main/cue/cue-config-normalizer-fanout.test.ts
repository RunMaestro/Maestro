/**
 * Tests for the normalizer's `fan_out_prompt_files` → `fan_out_prompts`
 * resolution. Uses real files on a temp projectRoot so we exercise the
 * full readPromptFile path (no fs mocks).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import {
	parseCueConfigDocument,
	materializeCueConfig,
} from '../../../main/cue/config/cue-config-normalizer';

let projectRoot = '';

beforeEach(() => {
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-fanout-norm-'));
	fs.mkdirSync(path.join(projectRoot, '.maestro/prompts'), { recursive: true });
});

afterEach(() => {
	if (projectRoot && fs.existsSync(projectRoot)) {
		fs.rmSync(projectRoot, { recursive: true, force: true });
	}
});

function writePrompt(relativePath: string, content: string) {
	fs.writeFileSync(path.join(projectRoot, relativePath), content, 'utf-8');
}

describe('normalizer — fan_out_prompt_files resolution', () => {
	it('expands fan_out_prompt_files into fan_out_prompts at load time', () => {
		writePrompt('.maestro/prompts/codex_1-pipeline_1.md', 'codex work');
		writePrompt('.maestro/prompts/opencode_1-pipeline_1.md', 'opencode work');
		writePrompt('.maestro/prompts/claude_1-pipeline_1.md', 'claude work');

		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'Pipeline 1',
					event: 'app.startup',
					fan_out: ['Codex 1', 'OpenCode 1', 'Claude 1'],
					fan_out_prompt_files: [
						'.maestro/prompts/codex_1-pipeline_1.md',
						'.maestro/prompts/opencode_1-pipeline_1.md',
						'.maestro/prompts/claude_1-pipeline_1.md',
					],
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		expect(doc).not.toBeNull();
		const { config } = materializeCueConfig(doc!);
		const sub = config.subscriptions[0];

		expect(sub.fan_out_prompts).toEqual(['codex work', 'opencode work', 'claude work']);
		// The raw file list survives materialization so the UI can edit
		// individual files without losing their paths.
		expect(sub.fan_out_prompt_files).toEqual([
			'.maestro/prompts/codex_1-pipeline_1.md',
			'.maestro/prompts/opencode_1-pipeline_1.md',
			'.maestro/prompts/claude_1-pipeline_1.md',
		]);
	});

	it('still reads legacy inline fan_out_prompts when fan_out_prompt_files is absent', () => {
		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'Legacy Pipeline',
					event: 'app.startup',
					fan_out: ['A', 'B'],
					fan_out_prompts: ['do A', 'do B'],
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		const { config } = materializeCueConfig(doc!);
		const sub = config.subscriptions[0];

		expect(sub.fan_out_prompts).toEqual(['do A', 'do B']);
		expect(sub.fan_out_prompt_files).toBeUndefined();
	});

	it('falls back to inline array at the same index when a file is missing', () => {
		// First file exists, second is missing on disk, third exists.
		writePrompt('.maestro/prompts/a.md', 'A from file');
		writePrompt('.maestro/prompts/c.md', 'C from file');

		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'Mixed',
					event: 'app.startup',
					fan_out: ['A', 'B', 'C'],
					fan_out_prompt_files: [
						'.maestro/prompts/a.md',
						'.maestro/prompts/missing.md',
						'.maestro/prompts/c.md',
					],
					// Author dual-wrote inline as a defensive fallback.
					fan_out_prompts: ['A inline', 'B inline', 'C inline'],
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		const { config } = materializeCueConfig(doc!);
		const sub = config.subscriptions[0];

		// Files win where they exist; inline wins where the file is missing.
		expect(sub.fan_out_prompts).toEqual(['A from file', 'B inline', 'C from file']);
	});

	it('returns empty string for missing files when no inline fallback is present', () => {
		writePrompt('.maestro/prompts/a.md', 'A content');
		// b.md deliberately NOT written

		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'Partial',
					event: 'app.startup',
					fan_out: ['A', 'B'],
					fan_out_prompt_files: ['.maestro/prompts/a.md', '.maestro/prompts/b.md'],
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		const { config } = materializeCueConfig(doc!);
		const sub = config.subscriptions[0];

		expect(sub.fan_out_prompts).toEqual(['A content', '']);
	});

	it('leaves fan_out_prompts undefined when neither field is present (shared-prompt fan-out)', () => {
		const raw = yaml.dump({
			subscriptions: [
				{
					name: 'Shared',
					event: 'app.startup',
					fan_out: ['A', 'B', 'C'],
					prompt: 'shared across all',
				},
			],
		});

		const doc = parseCueConfigDocument(raw, projectRoot);
		const { config } = materializeCueConfig(doc!);
		const sub = config.subscriptions[0];

		expect(sub.fan_out_prompts).toBeUndefined();
		expect(sub.prompt).toBe('shared across all');
	});
});
