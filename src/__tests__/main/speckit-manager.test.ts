import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn().mockReturnValue('/temporary-profile'),
		isPackaged: false,
	},
}));

vi.mock('fs/promises', () => ({
	default: {
		readFile: vi.fn(),
		writeFile: vi.fn(),
		mkdir: vi.fn(),
		rm: vi.fn(),
	},
}));

vi.mock('../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn() },
}));

import { getSpeckitPrompts, type SpecKitMetadata } from '../../main/speckit-manager';

function enoent(): NodeJS.ErrnoException {
	const error = new Error('ENOENT') as NodeJS.ErrnoException;
	error.code = 'ENOENT';
	return error;
}

describe('speckit-manager temporary-profile smoke', () => {
	const metadata: SpecKitMetadata = {
		lastRefreshed: '2026-01-01T00:00:00.000Z',
		commitSha: 'fixture',
		sourceVersion: '1.0.0',
		sourceUrl: 'https://github.com/github/spec-kit',
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fs.readFile).mockImplementation(async (pathname) => {
			const filename = pathname.toString();
			if (filename.includes('speckit-customizations.json')) {
				return JSON.stringify({
					metadata,
					prompts: {
						constitution: { content: 'user constitution', isModified: true },
					},
				});
			}
			if (filename.includes('speckit-prompts') && filename.endsWith('speckit.constitution.md')) {
				return 'downloaded constitution';
			}
			if (filename.endsWith('.md')) return 'bundled golden prompt';
			throw enoent();
		});
	});

	it('loads golden bundled commands while retaining a user customization over refreshed source', async () => {
		const commands = await getSpeckitPrompts();

		expect(commands).toHaveLength(10);
		expect(commands.find((command) => command.id === 'constitution')).toEqual(
			expect.objectContaining({
				command: '/speckit.constitution',
				prompt: 'user constitution',
				isModified: true,
			})
		);
		expect(commands.find((command) => command.id === 'help')).toEqual(
			expect.objectContaining({ prompt: 'bundled golden prompt' })
		);
	});
});
