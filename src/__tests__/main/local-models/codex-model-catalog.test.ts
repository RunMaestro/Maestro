/**
 * @file codex-model-catalog.test.ts
 *
 * The model catalog Maestro hands Codex for a Run on target: the entry is
 * Codex's own fallback for an unknown model with the target's window, and the
 * file is named by its content, written once, and never put on the command
 * line when a shell could change its path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	codexModelCatalog,
	codexModelCatalogEntry,
	writeCodexModelCatalog,
} from '../../../main/local-models/codex-model-catalog';
import { CODEX_BASE_INSTRUCTIONS } from '../../../main/local-models/vendor/codex-base-instructions';

describe('codexModelCatalogEntry', () => {
	const entry = codexModelCatalogEntry('deepseek-v4.1-flash:cloud', 1_000_000);

	it('names the model as the source serves it', () => {
		expect(entry.slug).toBe('deepseek-v4.1-flash:cloud');
		expect(entry.display_name).toBe('deepseek-v4.1-flash:cloud');
	});

	it('sets both windows, because Codex clamps the configured one to the maximum', () => {
		expect(entry.context_window).toBe(1_000_000);
		expect(entry.max_context_window).toBe(1_000_000);
		expect(entry.effective_context_window_percent).toBe(95);
	});

	it("prompts the model with Codex's own fallback instructions", () => {
		expect(entry.model_messages.instructions_template).toBe(CODEX_BASE_INSTRUCTIONS);
		expect(CODEX_BASE_INSTRUCTIONS).toMatch(/^You are a coding agent running in the Codex CLI/);
	});

	it("keeps the fallback's values where Codex's deserializer would default otherwise", () => {
		expect(entry).toMatchObject({
			shell_type: 'unified_exec',
			visibility: 'none',
			priority: 99,
			include_apps_usage_instructions: false,
			default_reasoning_summary: 'auto',
			web_search_tool_type: 'text',
			truncation_policy: { mode: 'bytes', limit: 10_000 },
			experimental_supported_tools: [],
		});
	});

	it('is the only entry in the catalog', () => {
		expect(JSON.parse(codexModelCatalog('m', 65_536))).toEqual({
			models: [codexModelCatalogEntry('m', 65_536)],
		});
	});
});

describe('writeCodexModelCatalog', () => {
	let dir: string;

	beforeEach(() => {
		dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-')), 'catalogs');
	});

	afterEach(() => {
		fs.rmSync(path.dirname(dir), { recursive: true, force: true });
	});

	it('writes the catalog under a name taken from its content', async () => {
		const written = await writeCodexModelCatalog('qwen3:latest', 131_072, dir);

		if (!written.ok) throw new Error(written.reason);
		expect(path.dirname(written.path)).toBe(dir);
		expect(path.basename(written.path)).toMatch(/^codex-[0-9a-f]{16}\.json$/);
		expect(fs.readFileSync(written.path, 'utf8')).toBe(codexModelCatalog('qwen3:latest', 131_072));
	});

	it('hands back the same file for the same model and window, without writing it again', async () => {
		const first = await writeCodexModelCatalog('qwen3:latest', 131_072, dir);
		if (!first.ok) throw new Error(first.reason);
		const past = new Date('2020-01-01T00:00:00Z');
		fs.utimesSync(first.path, past, past);

		const second = await writeCodexModelCatalog('qwen3:latest', 131_072, dir);

		expect(second).toEqual(first);
		expect(fs.statSync(first.path).mtime.getTime()).toBe(past.getTime());
	});

	it('writes a different file for a different window', async () => {
		const small = await writeCodexModelCatalog('qwen3:latest', 65_536, dir);
		const large = await writeCodexModelCatalog('qwen3:latest', 131_072, dir);

		if (!small.ok || !large.ok) throw new Error('expected both to be written');
		expect(small.path).not.toBe(large.path);
	});

	it('writes nothing to a path a shell could split, and says why', async () => {
		const spaced = path.join(path.dirname(dir), 'with space');

		const written = await writeCodexModelCatalog('qwen3:latest', 131_072, spaced);

		expect(written).toMatchObject({ ok: false });
		if (written.ok) throw new Error('expected a reason');
		expect(written.reason).toContain('cannot be passed');
		expect(fs.existsSync(spaced)).toBe(false);
	});

	it('answers with a reason, not an exception, when the folder cannot be made', async () => {
		fs.mkdirSync(path.dirname(dir), { recursive: true });
		fs.writeFileSync(dir, 'a file where the folder should be');

		const written = await writeCodexModelCatalog('qwen3:latest', 131_072, dir);

		expect(written).toMatchObject({ ok: false });
		if (written.ok) throw new Error('expected a reason');
		expect(written.reason).toContain('could not be written');
	});
});
