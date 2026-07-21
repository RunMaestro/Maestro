/**
 * @file prompt-loader.test.ts
 * @description Tests for the CLI prompt loader: customization precedence,
 * candidate-path fallback, in-memory caching, and `{{REF:name}}` resolution.
 *
 * The renderer/main pair (src/main/prompt-manager.ts) is the canonical impl
 * - the CLI loader mirrors its behavior so an agent driven by `maestro-cli`
 * sees the same content as a desktop-spawned agent, including the absolute
 * on-disk paths that `{{REF:_interface-primitives}}` etc. expand to.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Single shared mock fn so the named-export and default-export view of
// `fs/promises.readFile` are the same instance - otherwise the prompt-loader
// reads via the default while tests configure the named (or vice versa) and
// the configuration goes nowhere. `vi.hoisted` is required because `vi.mock`
// calls are hoisted to the top of the file; referencing a plain `const`
// declared between imports breaks on hoist-ordering in newer vitest
// (CI hits "Cannot access 'mockReadFile' before initialization").
const { mockReadFile } = vi.hoisted(() => ({ mockReadFile: vi.fn() }));
vi.mock('fs/promises', () => ({
	default: { readFile: mockReadFile },
	readFile: mockReadFile,
}));

vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	// `actual.constants` is a getter on the fs module - spreading `actual`
	// drops it (only own enumerable data properties carry through), and
	// `getBundledPromptsDir` reads `fs.constants.R_OK`. Inline the literal
	// so the mock surface still exposes a usable constants object.
	const mocked = {
		...actual,
		accessSync: vi.fn(),
		constants: { ...actual.constants, R_OK: 4 },
	};
	return { ...mocked, default: mocked };
});

vi.mock('../../../cli/services/storage', () => ({
	getConfigDirectory: vi.fn(() => '/mock/config'),
}));

import fsSync from 'fs';
import path from 'path';
import {
	_getBundledPromptCandidatesForTests,
	getCliPrompt,
	_resetCliPromptCacheForTests,
} from '../../../cli/services/prompt-loader';

describe('CLI prompt-loader', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		_resetCliPromptCacheForTests();
	});

	it('returns the user-customized content when one exists and skips bundled', async () => {
		// First call: read customizations file → returns user-edited content.
		// fs.promises.readFile reads the customizations json then never reads
		// any bundled fallback (asserted by call count).
		mockReadFile.mockResolvedValueOnce(
			JSON.stringify({
				prompts: {
					'autorun-default': {
						content: 'user edited content',
						isModified: true,
					},
				},
			})
		);
		// accessSync probes for the bundled REF resolver dir - return success
		// so subsequent REF expansion has a stable root if it ever runs.
		vi.mocked(fsSync.accessSync).mockReturnValue(undefined);

		const content = await getCliPrompt('autorun-default');

		expect(content).toBe('user edited content');
		// Only the customizations file should have been read - no bundled fallback
		expect(mockReadFile).toHaveBeenCalledTimes(1);
	});

	it('falls back to bundled content when no customization is present', async () => {
		// 1st readFile: customizations file → ENOENT
		// 2nd readFile: first bundled candidate succeeds
		const customizationErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		mockReadFile.mockRejectedValueOnce(customizationErr).mockResolvedValueOnce('bundled content');
		vi.mocked(fsSync.accessSync).mockReturnValue(undefined);

		const content = await getCliPrompt('autorun-default');

		expect(content).toBe('bundled content');
		// Customizations + first bundled candidate were tried
		expect(mockReadFile).toHaveBeenCalled();
	});

	it('finds checkout prompts from the standalone dist/cli bundle layout', () => {
		const filename = '_interface-primitives.md';
		const moduleDirectory = path.join(process.cwd(), 'dist', 'cli');
		const expected = path.join(process.cwd(), 'src', 'prompts', filename);

		expect(_getBundledPromptCandidatesForTests(filename, moduleDirectory)).toContain(expected);
	});

	it('caches a loaded prompt so subsequent calls do not re-read the filesystem', async () => {
		mockReadFile.mockResolvedValueOnce(
			JSON.stringify({
				prompts: { 'autorun-default': { content: 'cached', isModified: true } },
			})
		);
		vi.mocked(fsSync.accessSync).mockReturnValue(undefined);

		const first = await getCliPrompt('autorun-default');
		const second = await getCliPrompt('autorun-default');

		expect(first).toBe('cached');
		expect(second).toBe('cached');
		expect(mockReadFile).toHaveBeenCalledTimes(1);
	});

	it('expands {{REF:name}} to the absolute on-disk path of the bundled file', async () => {
		// Customizations file ENOENT, then bundled file contains a REF.
		// accessSync says the probe file exists so getBundledPromptsDir resolves.
		const customizationErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		mockReadFile
			.mockRejectedValueOnce(customizationErr)
			.mockResolvedValueOnce('See `{{REF:_interface-primitives}}` for the routing table.\n');
		vi.mocked(fsSync.accessSync).mockReturnValue(undefined);

		const content = await getCliPrompt('maestro-system-prompt');

		// The REF must have been replaced with a string that looks like an
		// absolute path ending in the include's filename. Both Unix and Windows
		// emit native separators, so just assert the filename component.
		expect(content).toMatch(/_interface-primitives\.md/);
		expect(content).not.toContain('{{REF:_interface-primitives}}');
	});

	it('leaves an unknown {{REF:...}} placeholder unchanged (no panic)', async () => {
		const customizationErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		mockReadFile
			.mockRejectedValueOnce(customizationErr)
			.mockResolvedValueOnce('hello {{REF:not-a-real-prompt-id}} world');
		vi.mocked(fsSync.accessSync).mockReturnValue(undefined);

		const content = await getCliPrompt('autorun-default');

		expect(content).toBe('hello {{REF:not-a-real-prompt-id}} world');
	});

	it('throws when no candidate file can be loaded', async () => {
		const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		// Every readFile call (customizations + every bundled candidate) fails
		mockReadFile.mockRejectedValue(enoent);
		vi.mocked(fsSync.accessSync).mockImplementation(() => {
			throw enoent;
		});

		await expect(getCliPrompt('autorun-default')).rejects.toThrow(/Failed to load prompt/);
	});
});
