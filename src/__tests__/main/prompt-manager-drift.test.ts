/**
 * Drift detection for core prompt customizations.
 *
 * Verifies the hash-based check that flags a customized prompt as drifted when
 * the bundled default has changed since the user saved their override. Also
 * covers the legacy-customization backfill (entries missing originalHash get
 * the current bundled hash written back so future drift can be detected).
 */

import crypto from 'crypto';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CORE_PROMPTS } from '../../shared/promptDefinitions';

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn().mockReturnValue('/mock/userData'),
		isPackaged: false,
	},
}));

vi.mock('fs/promises', () => ({
	default: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
	},
}));

vi.mock('fs', () => ({
	default: {
		readFileSync: vi.fn(),
	},
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

const customizationsPath = path.join('/mock/userData', 'core-prompts-customizations.json');

function hash(content: string): string {
	return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

async function withMockedFs(opts: {
	bundledContents: Record<string, string>;
	bundledFallback: string;
	storedCustomizations: Record<string, unknown> | null;
}) {
	const fsModule = await import('fs/promises');
	const fs = fsModule.default as unknown as {
		readFile: ReturnType<typeof vi.fn>;
		writeFile: ReturnType<typeof vi.fn>;
	};
	fs.readFile.mockReset();
	fs.writeFile.mockReset();
	fs.writeFile.mockResolvedValue(undefined);
	fs.readFile.mockImplementation(async (filePath: string) => {
		if (filePath === customizationsPath) {
			if (opts.storedCustomizations === null) {
				const err = new Error('ENOENT') as NodeJS.ErrnoException;
				err.code = 'ENOENT';
				throw err;
			}
			return JSON.stringify({ prompts: opts.storedCustomizations });
		}
		const filename = path.basename(filePath);
		const id = filename.replace(/\.md$/, '');
		return opts.bundledContents[id] ?? opts.bundledFallback;
	});
	return fs;
}

describe('prompt-manager drift detection', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('flags hasDefaultDrifted when the bundled default changes after a save', async () => {
		// User saved against an old bundled version (originalHash matches OLD content);
		// current bundled default has shifted.
		const oldDefault = '# old default\n';
		const newDefault = '# new default v2\n';
		const userOverride = '# my custom version\n';
		const targetId = CORE_PROMPTS[0].id;

		await withMockedFs({
			bundledContents: { [targetId]: newDefault },
			bundledFallback: '# default\n',
			storedCustomizations: {
				[targetId]: {
					content: userOverride,
					isModified: true,
					originalHash: hash(oldDefault),
					modifiedAt: '2026-01-01T00:00:00Z',
				},
			},
		});

		const { initializePrompts, getAllPrompts } = await import('../../main/prompt-manager');
		await initializePrompts();
		const all = getAllPrompts();
		const target = all.find((p) => p.id === targetId)!;

		expect(target.isModified).toBe(true);
		expect(target.hasDefaultDrifted).toBe(true);
		expect(target.content).toBe(userOverride);
	});

	it('does not flag drift when the saved hash still matches the current bundled default', async () => {
		const currentDefault = '# stable default\n';
		const userOverride = '# my customization\n';
		const targetId = CORE_PROMPTS[0].id;

		await withMockedFs({
			bundledContents: { [targetId]: currentDefault },
			bundledFallback: '# default\n',
			storedCustomizations: {
				[targetId]: {
					content: userOverride,
					isModified: true,
					originalHash: hash(currentDefault),
				},
			},
		});

		const { initializePrompts, getAllPrompts } = await import('../../main/prompt-manager');
		await initializePrompts();
		const target = getAllPrompts().find((p) => p.id === targetId)!;

		expect(target.isModified).toBe(true);
		expect(target.hasDefaultDrifted).toBe(false);
	});

	it('backfills missing originalHash on legacy customizations with the current bundled hash', async () => {
		const currentDefault = '# legacy default\n';
		const userOverride = '# legacy override\n';
		const targetId = CORE_PROMPTS[0].id;

		const fs = await withMockedFs({
			bundledContents: { [targetId]: currentDefault },
			bundledFallback: '# default\n',
			storedCustomizations: {
				[targetId]: {
					content: userOverride,
					isModified: true,
					// No originalHash — this is a legacy entry written before drift tracking.
				},
			},
		});

		const { initializePrompts, getAllPrompts } = await import('../../main/prompt-manager');
		await initializePrompts();

		// Legacy entries are treated as "in sync with current bundled" rather than
		// false-flagged as drifted — we have no baseline to compare against.
		const target = getAllPrompts().find((p) => p.id === targetId)!;
		expect(target.hasDefaultDrifted).toBe(false);

		// Backfill writes the current bundled hash so future drift can be detected.
		expect(fs.writeFile).toHaveBeenCalledWith(
			customizationsPath,
			expect.stringContaining(hash(currentDefault)),
			'utf-8'
		);
	});

	it('reports hasDefaultDrifted = false for unmodified prompts', async () => {
		const targetId = CORE_PROMPTS[0].id;
		await withMockedFs({
			bundledContents: { [targetId]: '# anything\n' },
			bundledFallback: '# default\n',
			storedCustomizations: {},
		});

		const { initializePrompts, getAllPrompts } = await import('../../main/prompt-manager');
		await initializePrompts();
		const target = getAllPrompts().find((p) => p.id === targetId)!;
		expect(target.isModified).toBe(false);
		expect(target.hasDefaultDrifted).toBe(false);
	});
});
