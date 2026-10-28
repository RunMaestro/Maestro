/**
 * @file secret-screen.test.ts
 * @description `generateDebugPackage` screens what it collected before it
 * writes anything. A support package is usually attached to a public issue, so
 * a credential a collector missed must stop the zip, not travel in it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const collected = vi.hoisted(() => ({ logs: {} as unknown, settings: {} as unknown }));

vi.mock('../../../main/debug-package/collectors/system', () => ({
	collectSystemInfo: () => ({ platform: 'darwin' }),
}));
vi.mock('../../../main/debug-package/collectors/settings', () => ({
	collectSettings: async () => collected.settings,
}));
vi.mock('../../../main/debug-package/collectors/agents', () => ({
	collectAgents: async () => ({ agents: [] }),
}));
vi.mock('../../../main/debug-package/collectors/external-tools', () => ({
	collectExternalTools: async () => ({}),
}));
vi.mock('../../../main/debug-package/collectors/groups', () => ({
	collectGroups: () => [],
}));
vi.mock('../../../main/debug-package/collectors/sessions', () => ({
	collectSessions: async () => [],
}));
vi.mock('../../../main/debug-package/collectors/processes', () => ({
	collectProcesses: async () => [],
}));
vi.mock('../../../main/debug-package/collectors/logs', () => ({
	collectLogs: () => collected.logs,
}));
vi.mock('../../../main/debug-package/collectors/errors', () => ({
	collectErrors: () => ({}),
}));
vi.mock('../../../main/debug-package/collectors/web-server', () => ({
	collectWebServer: async () => ({}),
}));
vi.mock('../../../main/debug-package/collectors/storage', () => ({
	collectStorage: async () => ({}),
}));
vi.mock('../../../main/debug-package/collectors/group-chats', () => ({
	collectGroupChats: async () => [],
}));
vi.mock('../../../main/debug-package/collectors/batch-state', () => ({
	collectBatchState: () => ({}),
}));
vi.mock('../../../main/debug-package/collectors/windows-diagnostics', () => ({
	collectWindowsDiagnostics: async () => ({}),
}));
vi.mock('../../../main/debug-package/collectors/voice-runtime', () => ({
	collectVoiceRuntime: async () => ({}),
}));

vi.mock('../../../main/debug-package/packager', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/debug-package/packager')>()),
	createZipPackage: vi.fn(async (outputDir: string) => ({
		path: `${outputDir}/maestro-debug.zip`,
		sizeBytes: 321,
	})),
}));

// The optional model pass is off, the shipped default: patterns decide alone.
vi.mock('../../../main/local-models/task-router', () => ({
	// Asked first: it answers `not-assigned` for any assignment but System One.
	runSystemOneTask: vi.fn(async () => ({ status: 'not-assigned' })),
	runClassifierTask: vi.fn(async () => ({ status: 'off' })),
}));

import { generateDebugPackage } from '../../../main/debug-package';
import { createZipPackage } from '../../../main/debug-package/packager';

// Assembled at runtime so no token literal sits in the repository.
const GITHUB_TOKEN = ['ghp', 'a1B2c3D4e5'.repeat(4).slice(0, 36)].join('_');

const deps = {
	getAgentDetector: () => null,
	getProcessManager: () => null,
	getWebServer: () => null,
	settingsStore: {},
	sessionsStore: {},
	groupsStore: {},
} as any;

describe('generateDebugPackage secret screen', () => {
	beforeEach(() => {
		vi.mocked(createZipPackage).mockClear();
		collected.logs = { entries: [{ message: 'app started' }] };
		collected.settings = { theme: 'dracula' };
	});

	it('writes a clean package', async () => {
		const result = await generateDebugPackage('/out', deps);

		expect(result).toMatchObject({ success: true, path: '/out/maestro-debug.zip' });
		expect(result.secretFindings).toBeUndefined();
		expect(createZipPackage).toHaveBeenCalledTimes(1);
	});

	it('writes nothing when a collected file holds a token, and says which file and line', async () => {
		collected.logs = {
			entries: [{ message: 'app started' }, { message: `auth header was ${GITHUB_TOKEN}` }],
		};

		const result = await generateDebugPackage('/out', deps);

		expect(result).toEqual({
			success: false,
			error: 'Found 1 possible secret in the support package. Nothing was sent.',
			code: 'SECRETS_FOUND',
			secretFindings: [
				{
					kind: 'github-token',
					// The line in logs.json as it would have been written to the zip.
					line: 7,
					preview: `••••••••${GITHUB_TOKEN.slice(-4)}`,
					source: 'logs.json',
				},
			],
			filesIncluded: [],
			totalSizeBytes: 0,
		});
		expect(JSON.stringify(result)).not.toContain(GITHUB_TOKEN);
		expect(createZipPackage).not.toHaveBeenCalled();
	});

	it('does not ask where to save a package it is about to refuse', async () => {
		collected.settings = { webhook: GITHUB_TOKEN };
		const chooseDestination = vi.fn(async () => '/picked');

		const result = await generateDebugPackage(chooseDestination, deps);

		expect(result.code).toBe('SECRETS_FOUND');
		expect(result.secretFindings?.[0].source).toBe('settings.json');
		expect(chooseDestination).not.toHaveBeenCalled();
		expect(createZipPackage).not.toHaveBeenCalled();
	});

	it('writes the package as collected when secrets are allowed', async () => {
		collected.logs = { entries: [{ message: GITHUB_TOKEN }] };

		const result = await generateDebugPackage('/out', deps, { allowSecrets: true });

		expect(result.success).toBe(true);
		expect(createZipPackage).toHaveBeenCalledTimes(1);
	});

	it('leaves a section the caller excluded out of the screen', async () => {
		collected.logs = { entries: [{ message: GITHUB_TOKEN }] };

		const result = await generateDebugPackage('/out', deps, { includeLogs: false });

		expect(result.success).toBe(true);
		expect(result.filesIncluded).not.toContain('logs.json');
	});

	it('asks the destination function once the screen passes, and uses its answer', async () => {
		const chooseDestination = vi.fn(async () => '/picked');

		const result = await generateDebugPackage(chooseDestination, deps);

		expect(chooseDestination).toHaveBeenCalledTimes(1);
		expect(result.path).toBe('/picked/maestro-debug.zip');
	});

	it('reports cancelled when the destination function returns nothing', async () => {
		const result = await generateDebugPackage(async () => null, deps);

		expect(result).toEqual({
			success: false,
			cancelled: true,
			filesIncluded: [],
			totalSizeBytes: 0,
		});
		expect(createZipPackage).not.toHaveBeenCalled();
	});
});
