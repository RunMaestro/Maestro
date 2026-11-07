import { afterEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import {
	requireBoardIsolation,
	readBoardIsolationRegistries,
	assertBoardIsolationBootstrap,
} from '../../../main/board/board-isolation';

type Fixture = (
	args: Record<string, unknown>,
	use: (value: unknown) => Promise<void>
) => Promise<void>;
const captured = vi.hoisted(() => ({ fixtures: {} as Record<string, Fixture> }));
vi.mock('@playwright/test', () => ({
	test: {
		extend: (fixtures: Record<string, Fixture>) => {
			captured.fixtures = fixtures;
			return fixtures;
		},
	},
	_electron: { launch: vi.fn() },
}));
import '../../../../e2e/fixtures/electron-app';
afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

it('admits the shared E2E child environment with the complete Board contract before launching', async () => {
	const fixture = createBoardIsolationFixture();
	const close = vi.fn(async () => {});
	try {
		vi.mocked(electron.launch).mockImplementation(async (options) => {
			const env = options!.env!;
			const contract = requireBoardIsolation({ env, expected: fixture.contract });
			assertBoardIsolationBootstrap(contract, env);
			expect(env.MAESTRO_USER_DATA).toBe(contract.userData);
			expect(env.MAESTRO_DEMO_DIR).toBe(contract.userData);
			expect(env.MAESTRO_DATA_DIR).toBe(contract.userData);
			expect(env.NODE_ENV).toBe('test');
			expect(env.MAESTRO_E2E_TEST).toBe('true');
			expect(readBoardIsolationRegistries(contract, env).sessions).toEqual([]);
			return { close } as unknown as ElectronApplication;
		});
		await captured.fixtures.electronApp(
			{
				appPath: 'unused',
				testDataDir: fixture.contract.userData,
				electronLaunchEnv: {},
				boardIsolation: fixture,
			},
			async () => {}
		);
		expect(electron.launch).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
	} finally {
		await fixture.cleanup();
	}
});

it('refuses E2E environment overrides outside the admitted Board contract before Electron launch', async () => {
	const fixture = createBoardIsolationFixture();
	try {
		await expect(
			captured.fixtures.electronApp(
				{
					appPath: 'unused',
					testDataDir: fixture.contract.userData,
					electronLaunchEnv: { MAESTRO_USER_DATA: fixture.sources.one },
					boardIsolation: fixture,
				},
				async () => {}
			)
		).rejects.toThrow('Board isolation refused');
		expect(electron.launch).not.toHaveBeenCalled();
	} finally {
		await fixture.cleanup();
	}
});

it('keeps the E2E seeded store directory inside one admitted contract and cleans up on failure', async () => {
	let root = '';
	await expect(
		captured.fixtures.boardIsolation({}, async (value) => {
			const fixture = value as ReturnType<typeof createBoardIsolationFixture>;
			root = fixture.contract.root;
			expect(fixture.contract.sync).toBe(fixture.contract.userData);
			await captured.fixtures.testDataDir({ boardIsolation: fixture }, async (dir) => {
				expect(dir).toBe(fixture.contract.userData);
			});
			assertBoardIsolationBootstrap(fixture.contract, fixture.env);
			throw new Error('E2E setup failed');
		})
	).rejects.toThrow('E2E setup failed');
	expect(existsSync(root)).toBe(false);
});
