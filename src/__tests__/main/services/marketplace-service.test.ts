/**
 * Service-level tests for src/main/services/marketplace-service.ts. The manifest and import flows
 * are tested through the IPC handler (src/__tests__/main/ipc/handlers/marketplace.test.ts).
 *
 * `deleteLaunchFolder` is Launch cleanup's only delete. Local agents run against a real temp
 * folder, so a refusal is proven by what is still on disk. SSH agents run the real remote-fs code
 * with only the SSH transport mocked, so the tests see the exact remote command.
 *
 * `launchMarketplacePlaybook` runs the same way: a real userData folder (local manifest, launch
 * records, saved playbooks), a real Auto Run folder, the real Auto Run state tracker, and a mocked
 * Auto Run starter in place of the renderer. Nothing reaches the network.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { App } from 'electron';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SshRemoteConfig } from '../../../shared/types';

const {
	mockLogger,
	mockGetSshRemoteById,
	mockExecFileNoThrow,
	mockBuildSshArgs,
	mockCaptureException,
	mockFetchWithTimeout,
} = vi.hoisted(() => ({
	mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	mockGetSshRemoteById: vi.fn(),
	mockExecFileNoThrow: vi.fn(),
	mockBuildSshArgs: vi.fn(),
	mockCaptureException: vi.fn(),
	mockFetchWithTimeout: vi.fn(async () => {
		throw new Error('The launch tests must not reach the network');
	}),
}));

vi.mock('../../../main/utils/logger', () => ({ logger: mockLogger }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: mockCaptureException }));
vi.mock('../../../main/stores/getters', () => ({ getSshRemoteById: mockGetSshRemoteById }));
// The SSH transport only. Even SSH discovery stays off the real host.
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: mockExecFileNoThrow }));
vi.mock('../../../main/utils/cliDetection', () => ({ resolveSshPath: vi.fn(async () => 'ssh') }));
vi.mock('../../../main/ssh-remote-manager', () => ({
	sshRemoteManager: { buildSshArgs: mockBuildSshArgs },
}));
vi.mock('../../../main/utils/fetchWithTimeout', () => ({
	fetchWithTimeout: mockFetchWithTimeout,
}));

import {
	deleteLaunchFolder,
	launchMarketplacePlaybook,
	type MarketplaceLaunchHost,
} from '../../../main/services/marketplace-service';
import {
	MarketplaceImportError,
	MarketplaceLaunchBusyError,
	MarketplaceLaunchCleanupError,
	MarketplaceLaunchValuesError,
	type PlaybookLaunchRecord,
	type PlaybookLaunchRequest,
	type PlaybookLaunchResult,
} from '../../../shared/marketplace-types';
import { parseLaunchSpec } from '../../../shared/playbookLaunch';
import { PLAYBOOK_LAUNCHES_FILE } from '../../../main/stores/playbookLaunchStore';
import {
	getAutoRunStateTracker,
	resetAutoRunStateTracker,
} from '../../../main/autorun/autorun-state-tracker';

const FOLDER = 'research-market-launch-2026-11-11-120000';

describe('deleteLaunchFolder', () => {
	let base: string;
	/** The agent's Auto Run folder */
	let root: string;
	/** A folder beside the Auto Run folder that no delete may reach */
	let outside: string;

	beforeEach(() => {
		vi.clearAllMocks();
		base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launch-cleanup-')));
		root = path.join(base, 'autorun');
		outside = path.join(base, 'outside');
		fs.mkdirSync(path.join(root, FOLDER, 'assets'), { recursive: true });
		fs.writeFileSync(path.join(root, FOLDER, '1_ANALYZE.md'), '- [ ] task');
		fs.writeFileSync(path.join(root, FOLDER, 'assets', 'helper.sh'), 'echo hi');
		fs.writeFileSync(path.join(root, 'My-Own-Doc.md'), 'mine');
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, 'keep.md'), 'keep');
	});

	afterEach(() => {
		fs.rmSync(base, { recursive: true, force: true });
	});

	/** Everything a refused delete must leave in place. */
	function expectNothingDeleted(): void {
		expect(fs.readFileSync(path.join(root, FOLDER, '1_ANALYZE.md'), 'utf-8')).toBe('- [ ] task');
		expect(fs.existsSync(path.join(root, FOLDER, 'assets', 'helper.sh'))).toBe(true);
		expect(fs.readFileSync(path.join(root, 'My-Own-Doc.md'), 'utf-8')).toBe('mine');
		expect(fs.readFileSync(path.join(outside, 'keep.md'), 'utf-8')).toBe('keep');
	}

	/** Replace the launch folder with a link to `outside` (a junction on Windows, which needs no privilege). */
	function replaceFolderWithLink(): string {
		const link = path.join(root, FOLDER);
		fs.rmSync(link, { recursive: true });
		fs.symlinkSync(outside, link, 'junction');
		return link;
	}

	describe('on this computer', () => {
		it('deletes the launch folder with everything in it, and nothing beside it', async () => {
			await expect(deleteLaunchFolder(root, FOLDER)).resolves.toEqual({
				targetPath: path.join(root, FOLDER),
				deleted: true,
			});

			expect(fs.existsSync(path.join(root, FOLDER))).toBe(false);
			expect(fs.readFileSync(path.join(root, 'My-Own-Doc.md'), 'utf-8')).toBe('mine');
			expect(fs.readFileSync(path.join(outside, 'keep.md'), 'utf-8')).toBe('keep');
			expect(mockGetSshRemoteById).not.toHaveBeenCalled();
			expect(mockExecFileNoThrow).not.toHaveBeenCalled();
			expect(mockLogger.info).toHaveBeenCalledWith(
				`Deleted launch folder ${path.join(root, FOLDER)}`,
				'[Marketplace]'
			);
		});

		it('accepts an Auto Run folder written with a trailing separator', async () => {
			await expect(deleteLaunchFolder(`${root}${path.sep}`, FOLDER)).resolves.toEqual({
				targetPath: path.join(root, FOLDER),
				deleted: true,
			});
		});

		it('resolves with deleted false when the folder is already gone', async () => {
			fs.rmSync(path.join(root, FOLDER), { recursive: true });

			await expect(deleteLaunchFolder(root, FOLDER)).resolves.toEqual({
				targetPath: path.join(root, FOLDER),
				deleted: false,
			});
			expect(fs.readFileSync(path.join(root, 'My-Own-Doc.md'), 'utf-8')).toBe('mine');
		});

		it('removes a link inside the folder without following it', async () => {
			fs.symlinkSync(outside, path.join(root, FOLDER, 'outputs'), 'junction');

			await expect(deleteLaunchFolder(root, FOLDER)).resolves.toMatchObject({ deleted: true });

			expect(fs.existsSync(path.join(root, FOLDER))).toBe(false);
			expect(fs.readFileSync(path.join(outside, 'keep.md'), 'utf-8')).toBe('keep');
		});

		it('refuses a symbolic link at the folder and leaves the link and its target alone', async () => {
			const link = replaceFolderWithLink();

			await expect(deleteLaunchFolder(root, FOLDER)).rejects.toThrow(
				`Refusing to delete the launch folder "${FOLDER}": it is a symbolic link`
			);

			expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
			expect(fs.readFileSync(path.join(outside, 'keep.md'), 'utf-8')).toBe('keep');
		});

		it('refuses a file at the folder', async () => {
			fs.rmSync(path.join(root, FOLDER), { recursive: true });
			fs.writeFileSync(path.join(root, FOLDER), 'not a folder');

			await expect(deleteLaunchFolder(root, FOLDER)).rejects.toThrow(
				`Refusing to delete the launch folder "${FOLDER}": it is not a folder`
			);
			expect(fs.readFileSync(path.join(root, FOLDER), 'utf-8')).toBe('not a folder');
		});

		it.each([
			'..',
			'../outside',
			'..\\outside',
			`${FOLDER}/../..`,
			`${FOLDER}/assets`,
			'assets\\..\\..',
		])('refuses the traversal %j', async (folder) => {
			const refusal = deleteLaunchFolder(root, folder);

			await expect(refusal).rejects.toBeInstanceOf(MarketplaceLaunchCleanupError);
			await expect(refusal).rejects.toThrow(
				`Refusing to delete the launch folder "${folder}": it is not a single folder name`
			);
			expectNothingDeleted();
		});

		it('refuses an absolute path in place of the folder name', async () => {
			for (const folder of [
				outside,
				root,
				path.join(root, FOLDER),
				'/etc',
				'C:\\Windows',
				'\\\\server\\share\\autorun',
				'~/autorun',
				'~',
			]) {
				await expect(deleteLaunchFolder(root, folder)).rejects.toThrow(
					`Refusing to delete the launch folder "${folder}": it is not a single folder name`
				);
			}
			expectNothingDeleted();
		});

		it('refuses to delete the Auto Run folder itself', async () => {
			for (const autoRunFolder of [root, `${root}${path.sep}`]) {
				await expect(deleteLaunchFolder(autoRunFolder, '.')).rejects.toThrow(
					'Refusing to delete the launch folder ".": it names the Auto Run folder itself'
				);
			}
			for (const blank of ['', '   ']) {
				await expect(deleteLaunchFolder(root, blank)).rejects.toThrow(
					`Refusing to delete the launch folder "${blank}": it is not a single folder name`
				);
			}
			// Windows reads a trailing dot or space away, so these name the Auto Run folder there.
			for (const alias of [' .', '. ', '.\t']) {
				await expect(deleteLaunchFolder(root, alias)).rejects.toBeInstanceOf(
					MarketplaceLaunchCleanupError
				);
			}
			expectNothingDeleted();
		});

		it.each([`${FOLDER}.`, `${FOLDER} `, `C:${FOLDER}`, `${FOLDER}:stream`, `${FOLDER}::$DATA`])(
			'refuses %j, which Windows reads as another path',
			async (folder) => {
				await expect(deleteLaunchFolder(root, folder)).rejects.toBeInstanceOf(
					MarketplaceLaunchCleanupError
				);
				expectNothingDeleted();
			}
		);

		it('refuses an Auto Run folder that is not an absolute path', async () => {
			for (const autoRunFolder of ['autorun', `.${path.sep}autorun`, '']) {
				await expect(deleteLaunchFolder(autoRunFolder, FOLDER)).rejects.toThrow(
					`Refusing to delete the launch folder "${FOLDER}": the Auto Run folder is not an absolute path`
				);
			}
			expectNothingDeleted();
		});
	});

	describe('on an SSH remote', () => {
		const REMOTE_ROOT = '/home/dev/project/.maestro/playbooks';
		const SSH_ARGS = ['-p', '22', 'dev@build.example.com'];
		const remote: SshRemoteConfig = {
			id: 'remote-1',
			name: 'Build box',
			host: 'build.example.com',
			port: 22,
			username: 'dev',
			privateKeyPath: '~/.ssh/id_ed25519',
			enabled: true,
		};

		/** The guarded delete `deleteDirectoryRemote` sends for an escaped path. */
		const guardedDelete = (escaped: string) =>
			`[ -L ${escaped} ] && exit 4; [ -e ${escaped} ] || exit 3; ` +
			`[ -d ${escaped} ] || exit 5; rm -rf -- ${escaped}`;

		const sentCommand = (): string => mockExecFileNoThrow.mock.calls[0][1].at(-1);

		beforeEach(() => {
			mockGetSshRemoteById.mockImplementation((id: string) =>
				id === remote.id ? remote : undefined
			);
			// remote-fs appends the command to the array it gets, so each call needs its own.
			mockBuildSshArgs.mockImplementation(() => [...SSH_ARGS]);
			mockExecFileNoThrow.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		});

		it('sends one SSH command that checks the folder and deletes it', async () => {
			await expect(deleteLaunchFolder(REMOTE_ROOT, FOLDER, 'remote-1')).resolves.toEqual({
				targetPath: `${REMOTE_ROOT}/${FOLDER}`,
				deleted: true,
			});

			expect(mockGetSshRemoteById).toHaveBeenCalledWith('remote-1');
			expect(mockBuildSshArgs).toHaveBeenCalledWith(remote);
			expect(mockExecFileNoThrow).toHaveBeenCalledTimes(1);
			const [command, args] = mockExecFileNoThrow.mock.calls[0];
			expect(command).toBe('ssh');
			expect(args).toEqual([
				...SSH_ARGS,
				"[ -L '/home/dev/project/.maestro/playbooks/research-market-launch-2026-11-11-120000' ] && exit 4; " +
					"[ -e '/home/dev/project/.maestro/playbooks/research-market-launch-2026-11-11-120000' ] || exit 3; " +
					"[ -d '/home/dev/project/.maestro/playbooks/research-market-launch-2026-11-11-120000' ] || exit 5; " +
					"rm -rf -- '/home/dev/project/.maestro/playbooks/research-market-launch-2026-11-11-120000'",
			]);
			expect(mockLogger.info).toHaveBeenCalledWith(
				`Deleted launch folder ${REMOTE_ROOT}/${FOLDER} (remote via SSH)`,
				'[Marketplace]'
			);
		});

		it('keeps a home-relative Auto Run folder expandable on the remote', async () => {
			await expect(
				deleteLaunchFolder('~/project/.maestro/playbooks/', FOLDER, 'remote-1')
			).resolves.toMatchObject({ targetPath: `~/project/.maestro/playbooks/${FOLDER}` });

			expect(sentCommand()).toBe(guardedDelete(`"$HOME/project/.maestro/playbooks/${FOLDER}"`));
		});

		it('normalizes repeated slashes and leaves the rest of the path for the remote to resolve', async () => {
			await expect(
				deleteLaunchFolder('/home/dev//project/./playbooks//', FOLDER, 'remote-1')
			).resolves.toMatchObject({ targetPath: `/home/dev/project/./playbooks/${FOLDER}` });

			expect(sentCommand()).toBe(guardedDelete(`'/home/dev/project/./playbooks/${FOLDER}'`));
		});

		it('escapes a hostile Auto Run folder so it cannot break out of the command', async () => {
			await deleteLaunchFolder("/home/dev/it's; rm -rf ~", FOLDER, 'remote-1');

			expect(sentCommand()).toBe(guardedDelete(`'/home/dev/it'\\''s; rm -rf ~/${FOLDER}'`));
		});

		it('resolves with deleted false when the remote folder is already gone', async () => {
			mockExecFileNoThrow.mockResolvedValue({ stdout: '', stderr: '', exitCode: 3 });

			await expect(deleteLaunchFolder(REMOTE_ROOT, FOLDER, 'remote-1')).resolves.toEqual({
				targetPath: `${REMOTE_ROOT}/${FOLDER}`,
				deleted: false,
			});
		});

		it.each([
			[4, 'it is a symbolic link'],
			[5, 'it is not a folder'],
		])('turns remote exit code %i into the refusal "%s"', async (exitCode, reason) => {
			mockExecFileNoThrow.mockResolvedValue({ stdout: '', stderr: '', exitCode });

			const refusal = deleteLaunchFolder(REMOTE_ROOT, FOLDER, 'remote-1');

			await expect(refusal).rejects.toBeInstanceOf(MarketplaceLaunchCleanupError);
			await expect(refusal).rejects.toThrow(
				`Refusing to delete the launch folder "${FOLDER}": ${reason}`
			);
		});

		it('throws any other remote failure as it is, not as a refusal', async () => {
			const stderr = `rm: cannot remove '${REMOTE_ROOT}/${FOLDER}/a.md': Permission denied`;
			mockExecFileNoThrow.mockResolvedValue({ stdout: '', stderr, exitCode: 1 });

			const failure = deleteLaunchFolder(REMOTE_ROOT, FOLDER, 'remote-1');

			await expect(failure).rejects.toThrow(
				`Failed to delete the launch folder ${REMOTE_ROOT}/${FOLDER} on SSH remote "remote-1": ${stderr}`
			);
			await expect(failure).rejects.not.toBeInstanceOf(MarketplaceLaunchCleanupError);
		});

		it.each([
			['missing', undefined],
			['disabled', { ...remote, enabled: false }],
		])('refuses a %s SSH remote without opening a connection', async (_state, config) => {
			mockGetSshRemoteById.mockReturnValue(config);

			await expect(deleteLaunchFolder(REMOTE_ROOT, FOLDER, 'remote-1')).rejects.toThrow(
				`Refusing to delete the launch folder "${FOLDER}": SSH remote "remote-1" is missing or disabled, and the same path on this computer is a different folder`
			);
			expect(mockExecFileNoThrow).not.toHaveBeenCalled();
		});

		// A Windows temp path is not a remote path, so this case exists only where the two agree.
		it.skipIf(process.platform === 'win32')(
			'never deletes the same path on this computer',
			async () => {
				await expect(deleteLaunchFolder(root, FOLDER, 'remote-1')).resolves.toMatchObject({
					deleted: true,
				});
				expect(sentCommand()).toBe(guardedDelete(`'${root}/${FOLDER}'`));
				expectNothingDeleted();

				mockGetSshRemoteById.mockReturnValue(undefined);
				await expect(deleteLaunchFolder(root, FOLDER, 'gone')).rejects.toBeInstanceOf(
					MarketplaceLaunchCleanupError
				);
				expectNothingDeleted();
			}
		);

		it.each(['..', '../outside', `${FOLDER}/assets`, '/etc', '~', `${FOLDER}.`])(
			'refuses the folder %j before any SSH lookup',
			async (folder) => {
				await expect(deleteLaunchFolder(REMOTE_ROOT, folder, 'remote-1')).rejects.toBeInstanceOf(
					MarketplaceLaunchCleanupError
				);
				expect(mockGetSshRemoteById).not.toHaveBeenCalled();
				expect(mockExecFileNoThrow).not.toHaveBeenCalled();
			}
		);

		it('refuses to delete the remote Auto Run folder itself', async () => {
			for (const autoRunFolder of [REMOTE_ROOT, `${REMOTE_ROOT}/`, '~', '$HOME']) {
				await expect(deleteLaunchFolder(autoRunFolder, '.', 'remote-1')).rejects.toThrow(
					'Refusing to delete the launch folder ".": it names the Auto Run folder itself'
				);
			}
			expect(mockExecFileNoThrow).not.toHaveBeenCalled();
		});

		it('refuses a remote Auto Run folder that is not absolute or home-relative', async () => {
			for (const autoRunFolder of [
				'project/playbooks',
				'./playbooks',
				'',
				'C:\\autorun',
				'~user',
			]) {
				await expect(deleteLaunchFolder(autoRunFolder, FOLDER, 'remote-1')).rejects.toThrow(
					`Refusing to delete the launch folder "${FOLDER}": the Auto Run folder is not an absolute path on the remote`
				);
			}
			expect(mockGetSshRemoteById).not.toHaveBeenCalled();
			expect(mockExecFileNoThrow).not.toHaveBeenCalled();
		});
	});
});

describe('launchMarketplacePlaybook', () => {
	/** The local time every test launches at, so the launch folder name is known */
	const NOW = new Date(2026, 10, 11, 9, 30, 0);
	const LAUNCH_FOLDER = 'market-research-launch-20261111-093000';

	const PROMPT = [
		'Map the market below.',
		'',
		'**MARKET_TOPIC:** `<UNSET MARKET_TOPIC>`',
		'**DEPTH_BATCH:** `3`',
		'',
	].join('\n');
	const SCOPE_DOC = '# Scope\n\n- [ ] Read [MARKET_TOPIC] from the prompt\n';
	const SWEEP_DOC = '# Sweep\n\n- [ ] Research [DEPTH_BATCH] entities\n';
	const HELPER = '#!/bin/sh\necho helper\n';

	const LAUNCH = {
		inputs: [
			{ name: 'MARKET_TOPIC', label: 'Market topic', type: 'text', required: true },
			{ name: 'DEPTH_BATCH', label: 'Depth batch', type: 'number', default: 3, min: 1 },
		],
		maxLoops: 30,
		outro: { summary: 'Mapped {{MARKET_TOPIC}}.', nextSteps: ['Open the vault'] },
	};

	let base: string;
	let userData: string;
	/** The agent's Auto Run folder */
	let root: string;
	/** Where the local manifest entry's documents and assets live */
	let source: string;
	let app: App;

	function manifestEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			id: 'research-market',
			title: 'Market Research',
			description: 'Map a market',
			category: 'Research',
			author: 'Maestro',
			lastUpdated: '2026-11-10',
			path: source,
			documents: [
				{ filename: '1_SCOPE', resetOnCompletion: false },
				{ filename: '2_SWEEP', resetOnCompletion: true },
			],
			loopEnabled: true,
			maxLoops: 5,
			prompt: PROMPT,
			taskSelectionMode: 'document',
			assets: ['helper.sh'],
			launch: LAUNCH,
			...overrides,
		};
	}

	function writeManifest(entries: Array<Record<string, unknown>>): void {
		fs.writeFileSync(
			path.join(userData, 'local-manifest.json'),
			JSON.stringify({ lastUpdated: '2026-11-10', playbooks: entries })
		);
	}

	function launchHost(overrides: Partial<MarketplaceLaunchHost> = {}): MarketplaceLaunchHost {
		return {
			app,
			startAutoRun: vi.fn(async () => ({ success: true })),
			isMaestroCliInstalled: vi.fn(async () => true),
			...overrides,
		};
	}

	function launchRequest(overrides: Partial<PlaybookLaunchRequest> = {}): PlaybookLaunchRequest {
		return {
			playbookId: 'research-market',
			values: { MARKET_TOPIC: '  EV chargers  ' },
			sessionId: 'agent-1',
			autoRunFolderPath: root,
			keepSavedPlaybook: false,
			...overrides,
		};
	}

	function savedPlaybooks(sessionId = 'agent-1'): any[] {
		const file = path.join(userData, 'playbooks', `${sessionId}.json`);
		return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')).playbooks : [];
	}

	function launchRecords(): PlaybookLaunchRecord[] {
		const file = path.join(userData, PLAYBOOK_LAUNCHES_FILE);
		return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')).launches : [];
	}

	function seedLaunchRecords(launches: Array<Partial<PlaybookLaunchRecord>>): void {
		fs.writeFileSync(
			path.join(userData, PLAYBOOK_LAUNCHES_FILE),
			JSON.stringify({ version: 1, launches })
		);
	}

	/** What a refused launch leaves: nothing in the Auto Run folder, no saved playbook, no record. */
	function expectNothingLaunched(host: MarketplaceLaunchHost): void {
		expect(fs.readdirSync(root)).toEqual([]);
		expect(savedPlaybooks()).toEqual([]);
		expect(launchRecords()).toEqual([]);
		expect(host.startAutoRun).not.toHaveBeenCalled();
	}

	/** The config `startAutoRun` received on its only call */
	function startedConfig(host: MarketplaceLaunchHost) {
		expect(host.startAutoRun).toHaveBeenCalledTimes(1);
		return vi.mocked(host.startAutoRun).mock.calls[0][1];
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		resetAutoRunStateTracker();

		base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launch-')));
		userData = path.join(base, 'userData');
		root = path.join(base, 'autorun');
		source = path.join(base, 'source');
		fs.mkdirSync(userData);
		fs.mkdirSync(root);
		fs.mkdirSync(path.join(source, 'assets'), { recursive: true });
		fs.writeFileSync(path.join(source, '1_SCOPE.md'), SCOPE_DOC);
		fs.writeFileSync(path.join(source, '2_SWEEP.md'), SWEEP_DOC);
		fs.writeFileSync(path.join(source, 'assets', 'helper.sh'), HELPER);
		// A fresh, empty official manifest, so the merged manifest is the local one and nothing is fetched.
		fs.writeFileSync(
			path.join(userData, 'marketplace-cache.json'),
			JSON.stringify({
				fetchedAt: Date.now(),
				manifest: { lastUpdated: '2026-11-10', playbooks: [] },
			})
		);
		writeManifest([manifestEntry()]);
		app = {
			getPath: vi.fn((_name: string) => userData),
			getVersion: vi.fn(() => '0.17.0'),
		} as unknown as App;
	});

	afterEach(() => {
		vi.useRealTimers();
		fs.rmSync(base, { recursive: true, force: true });
	});

	describe('on this computer', () => {
		it('imports into a new launch folder, records the launch and starts its Auto Run', async () => {
			const host = launchHost();

			const result = await launchMarketplacePlaybook(launchRequest(), host);

			expect(result).toEqual({ launchId: expect.any(String), folderRelativePath: LAUNCH_FOLDER });
			// The task documents are written as fetched, with the assets beside them.
			expect(fs.readdirSync(root)).toEqual([LAUNCH_FOLDER]);
			expect(fs.readFileSync(path.join(root, LAUNCH_FOLDER, '1_SCOPE.md'), 'utf-8')).toBe(
				SCOPE_DOC
			);
			expect(fs.readFileSync(path.join(root, LAUNCH_FOLDER, '2_SWEEP.md'), 'utf-8')).toBe(
				SWEEP_DOC
			);
			expect(fs.readFileSync(path.join(root, LAUNCH_FOLDER, 'assets', 'helper.sh'), 'utf-8')).toBe(
				HELPER
			);

			// Only the saved prompt carries the answers: trimmed, and the default where none was given.
			const saved = savedPlaybooks();
			expect(saved).toHaveLength(1);
			expect(saved[0]).toMatchObject({
				name: 'Market Research',
				prompt: PROMPT.replace('`<UNSET MARKET_TOPIC>`', '`EV chargers`'),
				documents: [
					{ filename: `${LAUNCH_FOLDER}/1_SCOPE`, resetOnCompletion: false },
					{ filename: `${LAUNCH_FOLDER}/2_SWEEP`, resetOnCompletion: true },
				],
				loopEnabled: true,
				maxLoops: 5,
				taskSelectionMode: 'document',
			});

			expect(launchRecords()).toEqual([
				{
					launchId: result.launchId,
					playbookId: 'research-market',
					playbookTitle: 'Market Research',
					sessionId: 'agent-1',
					folderRelativePath: LAUNCH_FOLDER,
					autoRunFolderPath: root,
					spec: parseLaunchSpec(LAUNCH).spec,
					savedPlaybookId: saved[0].id,
					keepSavedPlaybook: false,
					values: { MARKET_TOPIC: 'EV chargers', DEPTH_BATCH: 3 },
					status: 'running',
					appRunId: expect.any(String),
					startedAt: NOW.getTime(),
				},
			]);

			expect(host.startAutoRun).toHaveBeenCalledWith('agent-1', {
				documents: [
					{ filename: `${LAUNCH_FOLDER}/1_SCOPE`, resetOnCompletion: false },
					{ filename: `${LAUNCH_FOLDER}/2_SWEEP`, resetOnCompletion: true },
				],
				prompt: saved[0].prompt,
				loopEnabled: true,
				maxLoops: 30,
				taskSelectionMode: 'document',
				launch: true,
			});
			// No maestroCli precondition, so nothing asks whether the CLI is installed.
			expect(host.isMaestroCliInstalled).not.toHaveBeenCalled();
			expect(mockFetchWithTimeout).not.toHaveBeenCalled();
			expect(mockGetSshRemoteById).not.toHaveBeenCalled();
			expect(mockExecFileNoThrow).not.toHaveBeenCalled();
		});

		it('keeps the record the user asked to keep, and the answers it launched with', async () => {
			const result = await launchMarketplacePlaybook(
				launchRequest({
					keepSavedPlaybook: true,
					values: { MARKET_TOPIC: 'Heat pumps', DEPTH_BATCH: 6 },
				}),
				launchHost()
			);

			expect(launchRecords()).toEqual([
				expect.objectContaining({
					launchId: result.launchId,
					keepSavedPlaybook: true,
					values: { MARKET_TOPIC: 'Heat pumps', DEPTH_BATCH: 6 },
				}),
			]);
			expect(savedPlaybooks()[0].prompt).toContain('**DEPTH_BATCH:** `6`');
		});

		it.each([
			['the spec limit when the spec sets one', { maxLoops: 30 }, 30],
			["the playbook's own limit when the spec sets none", { maxLoops: undefined }, 5],
			['no limit when the spec says null', { maxLoops: null }, undefined],
		])('runs the loop with %s', async (_case, specLoops, expected) => {
			writeManifest([manifestEntry({ launch: { ...LAUNCH, ...specLoops } })]);
			const host = launchHost();

			await launchMarketplacePlaybook(launchRequest(), host);

			const config = startedConfig(host);
			if (expected === undefined) expect(config).not.toHaveProperty('maxLoops');
			else expect(config.maxLoops).toBe(expected);
		});

		it('leaves the task selection mode out when the playbook declares none', async () => {
			writeManifest([manifestEntry({ taskSelectionMode: undefined })]);
			const host = launchHost();

			await launchMarketplacePlaybook(launchRequest(), host);

			expect(startedConfig(host)).not.toHaveProperty('taskSelectionMode');
		});

		it('refuses answers that fail validation, naming every field, before writing anything', async () => {
			const host = launchHost();

			const refusal = launchMarketplacePlaybook(
				launchRequest({ values: { MARKET_TOPIC: '   ', DEPTH_BATCH: 0 } }),
				host
			);

			await expect(refusal).rejects.toBeInstanceOf(MarketplaceLaunchValuesError);
			await expect(refusal).rejects.toMatchObject({
				fieldErrors: { MARKET_TOPIC: 'This field is required', DEPTH_BATCH: 'Must be at least 1' },
			});
			expectNothingLaunched(host);
		});

		it.each([['EV chargers'], [['EV chargers']], [null], [3]])(
			'refuses values that are not an object keyed by input name (%j)',
			async (values) => {
				const host = launchHost();

				await expect(
					launchMarketplacePlaybook(launchRequest({ values: values as never }), host)
				).rejects.toThrow('values must be an object keyed by input name');
				expectNothingLaunched(host);
			}
		);

		it.each([[''], [undefined]])('refuses a missing agent id (%j)', async (sessionId) => {
			const host = launchHost();

			await expect(
				launchMarketplacePlaybook(launchRequest({ sessionId: sessionId as never }), host)
			).rejects.toThrow('sessionId is required');
			expectNothingLaunched(host);
		});

		it.each([['autorun'], ['./autorun'], ['']])(
			'refuses an Auto Run folder that is not absolute (%j)',
			async (autoRunFolderPath) => {
				const host = launchHost();

				await expect(
					launchMarketplacePlaybook(launchRequest({ autoRunFolderPath }), host)
				).rejects.toThrow(`The Auto Run folder must be an absolute path: ${autoRunFolderPath}`);
				expectNothingLaunched(host);
			}
		);

		it('refuses a playbook the manifest does not list', async () => {
			const host = launchHost();

			await expect(
				launchMarketplacePlaybook(launchRequest({ playbookId: 'no-such-playbook' }), host)
			).rejects.toThrow('Playbook not found: no-such-playbook');
			expectNothingLaunched(host);
		});

		it.each([
			['has no launch block', { launch: undefined }],
			['has a launch block the manifest dropped as invalid', { launch: { inputs: 'nope' } }],
		])('refuses a playbook that %s', async (_case, overrides) => {
			writeManifest([manifestEntry(overrides)]);
			const host = launchHost();

			await expect(launchMarketplacePlaybook(launchRequest(), host)).rejects.toThrow(
				'This playbook does not support Launch.'
			);
			expectNothingLaunched(host);
		});

		it('refuses a playbook that needs a newer Maestro to import at all', async () => {
			writeManifest([manifestEntry({ minMaestroVersion: '99.0.0' })]);
			const host = launchHost();

			await expect(launchMarketplacePlaybook(launchRequest(), host)).rejects.toThrow(
				'This playbook requires Maestro 99.0.0+; you have 0.17.0. Update Maestro and try again.'
			);
			expectNothingLaunched(host);
		});

		it('refuses a launch block that needs a newer Maestro', async () => {
			writeManifest([manifestEntry({ launch: { ...LAUNCH, minMaestroVersion: '99.0.0' } })]);
			const host = launchHost();

			await expect(launchMarketplacePlaybook(launchRequest(), host)).rejects.toThrow(
				'Launch needs Maestro 99.0.0 or newer (this is 0.17.0).'
			);
			expectNothingLaunched(host);
		});

		it('refuses a playbook that runs only on other platforms', async () => {
			const [elsewhere, name] =
				process.platform === 'linux' ? ['darwin', 'macOS'] : ['linux', 'Linux'];
			writeManifest([
				manifestEntry({ launch: { ...LAUNCH, preconditions: { platforms: [elsewhere] } } }),
			]);
			const host = launchHost();

			await expect(launchMarketplacePlaybook(launchRequest(), host)).rejects.toThrow(
				`This playbook runs on ${name} only.`
			);
			expectNothingLaunched(host);
		});

		it('refuses a playbook that requires maestro-cli when it is not installed', async () => {
			writeManifest([
				manifestEntry({ launch: { ...LAUNCH, preconditions: { maestroCli: 'required' } } }),
			]);
			const host = launchHost({ isMaestroCliInstalled: vi.fn(async () => false) });

			await expect(launchMarketplacePlaybook(launchRequest(), host)).rejects.toThrow(
				'This playbook drives Maestro through maestro-cli, which is not installed. Install maestro-cli to launch it.'
			);
			expect(host.isMaestroCliInstalled).toHaveBeenCalledTimes(1);
			expectNothingLaunched(host);
		});

		it('launches a playbook whose maestro-cli use is optional when it is not installed', async () => {
			writeManifest([
				manifestEntry({ launch: { ...LAUNCH, preconditions: { maestroCli: 'optional' } } }),
			]);
			const host = launchHost({ isMaestroCliInstalled: vi.fn(async () => false) });

			await expect(launchMarketplacePlaybook(launchRequest(), host)).resolves.toMatchObject({
				folderRelativePath: LAUNCH_FOLDER,
			});
			expect(host.startAutoRun).toHaveBeenCalledTimes(1);
		});

		it('takes an empty SSH remote id to mean this computer', async () => {
			await expect(
				launchMarketplacePlaybook(launchRequest({ sshRemoteId: '' }), launchHost())
			).resolves.toMatchObject({ folderRelativePath: LAUNCH_FOLDER });

			expect(mockGetSshRemoteById).not.toHaveBeenCalled();
			expect(launchRecords()[0]).not.toHaveProperty('sshRemoteId');
		});
	});

	describe('one launch per agent', () => {
		it('refuses a second launch while the agent runs one, and writes nothing more', async () => {
			const first = await launchMarketplacePlaybook(launchRequest(), launchHost());
			const host = launchHost();

			const refusal = launchMarketplacePlaybook(launchRequest(), host);

			await expect(refusal).rejects.toBeInstanceOf(MarketplaceLaunchBusyError);
			await expect(refusal).rejects.toMatchObject({ runningLaunchId: first.launchId });
			expect(fs.readdirSync(root)).toEqual([LAUNCH_FOLDER]);
			expect(savedPlaybooks()).toHaveLength(1);
			expect(launchRecords()).toHaveLength(1);
			expect(host.startAutoRun).not.toHaveBeenCalled();
		});

		it('refuses a launch on an agent that already runs another Auto Run', async () => {
			getAutoRunStateTracker().update('agent-1', { isRunning: true });
			const host = launchHost();

			await expect(launchMarketplacePlaybook(launchRequest(), host)).rejects.toThrow(
				'This agent is already running an Auto Run. Wait for it to finish, or stop it, then launch again.'
			);
			expectNothingLaunched(host);
		});

		it('launches on another agent while the first one runs a launch', async () => {
			await launchMarketplacePlaybook(launchRequest(), launchHost());

			const second = await launchMarketplacePlaybook(
				launchRequest({ sessionId: 'agent-2' }),
				launchHost()
			);

			// Same playbook, same second, same Auto Run folder: the second launch gets its own folder.
			expect(second.folderRelativePath).toBe(`${LAUNCH_FOLDER}-2`);
			expect(launchRecords().map((record) => record.sessionId)).toEqual(['agent-1', 'agent-2']);
		});

		it('lets only one of two simultaneous launches on one agent import, and starts only that one', async () => {
			const host = launchHost();

			const results = await Promise.allSettled([
				launchMarketplacePlaybook(launchRequest(), host),
				launchMarketplacePlaybook(launchRequest(), host),
			]);

			const fulfilled = results.filter(
				(result): result is PromiseFulfilledResult<PlaybookLaunchResult> =>
					result.status === 'fulfilled'
			);
			const rejected = results.filter(
				(result): result is PromiseRejectedResult => result.status === 'rejected'
			);
			expect(fulfilled).toHaveLength(1);
			expect(rejected).toHaveLength(1);
			expect(rejected[0].reason).toBeInstanceOf(MarketplaceImportError);
			expect(rejected[0].reason.message).toBe(
				'This agent is already starting a launch. Wait for it to finish, or stop it, then launch again.'
			);
			expect(fs.readdirSync(root)).toEqual([fulfilled[0].value.folderRelativePath]);
			expect(savedPlaybooks()).toHaveLength(1);
			expect(launchRecords()).toHaveLength(1);
			expect(host.startAutoRun).toHaveBeenCalledTimes(1);
		});

		it('releases the agent when a launch is refused, so the next one can start', async () => {
			const host = launchHost();
			await expect(
				launchMarketplacePlaybook(launchRequest({ values: {} }), host)
			).rejects.toBeInstanceOf(MarketplaceLaunchValuesError);

			await expect(launchMarketplacePlaybook(launchRequest(), host)).resolves.toMatchObject({
				folderRelativePath: LAUNCH_FOLDER,
			});
		});

		it('settles a launch that an earlier app run left running, then launches', async () => {
			seedLaunchRecords([
				{
					launchId: 'interrupted',
					playbookId: 'research-market',
					playbookTitle: 'Market Research',
					sessionId: 'agent-1',
					folderRelativePath: 'market-research-launch-20261110-080000',
					autoRunFolderPath: root,
					spec: parseLaunchSpec(LAUNCH).spec,
					savedPlaybookId: 'saved-before',
					keepSavedPlaybook: false,
					values: { MARKET_TOPIC: 'Solar' },
					status: 'running',
					appRunId: 'an-earlier-app-run',
					startedAt: NOW.getTime() - 86_400_000,
				},
			]);

			const result = await launchMarketplacePlaybook(launchRequest(), launchHost());

			const records = launchRecords();
			expect(records.find((record) => record.launchId === 'interrupted')?.status).toBe('failed');
			expect(records.find((record) => record.launchId === result.launchId)?.status).toBe('running');
		});
	});

	describe('the launch folder', () => {
		it('takes the next name when the launch folder name is taken, and leaves that folder alone', async () => {
			fs.mkdirSync(path.join(root, LAUNCH_FOLDER));
			fs.writeFileSync(path.join(root, LAUNCH_FOLDER, 'their-run.md'), 'theirs');
			fs.writeFileSync(path.join(root, `${LAUNCH_FOLDER}-2`), 'a file, not a folder');

			const result = await launchMarketplacePlaybook(launchRequest(), launchHost());

			expect(result.folderRelativePath).toBe(`${LAUNCH_FOLDER}-3`);
			expect(fs.readdirSync(path.join(root, LAUNCH_FOLDER))).toEqual(['their-run.md']);
			expect(fs.readFileSync(path.join(root, `${LAUNCH_FOLDER}-2`), 'utf-8')).toBe(
				'a file, not a folder'
			);
			expect(fs.readFileSync(path.join(root, `${LAUNCH_FOLDER}-3`, '1_SCOPE.md'), 'utf-8')).toBe(
				SCOPE_DOC
			);
			expect(launchRecords()[0].folderRelativePath).toBe(`${LAUNCH_FOLDER}-3`);
		});

		it('gives up when every launch folder name is taken', async () => {
			const taken = [
				LAUNCH_FOLDER,
				...[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `${LAUNCH_FOLDER}-${n}`),
			];
			for (const name of taken) fs.mkdirSync(path.join(root, name));
			const host = launchHost();

			await expect(launchMarketplacePlaybook(launchRequest(), host)).rejects.toThrow(
				`Every launch folder name from ${LAUNCH_FOLDER} to ${LAUNCH_FOLDER}-10 is taken`
			);
			expect(fs.readdirSync(root).sort()).toEqual([...taken].sort());
			expect(savedPlaybooks()).toEqual([]);
			expect(host.startAutoRun).not.toHaveBeenCalled();
		});

		it('names the folder after the playbook id when the title has no letter or digit', async () => {
			writeManifest([manifestEntry({ title: '* * *' })]);

			const result = await launchMarketplacePlaybook(launchRequest(), launchHost());

			expect(result.folderRelativePath).toBe('research-market-launch-20261111-093000');
		});

		it('creates a missing Auto Run folder, as an import does', async () => {
			fs.rmSync(root, { recursive: true });

			await launchMarketplacePlaybook(launchRequest(), launchHost());

			expect(fs.readdirSync(root)).toEqual([LAUNCH_FOLDER]);
		});
	});

	describe('a launch whose Auto Run does not start', () => {
		const otherPlaybook = { id: 'mine', name: 'My own playbook', documents: [], prompt: '' };

		beforeEach(() => {
			fs.mkdirSync(path.join(userData, 'playbooks'));
			fs.writeFileSync(
				path.join(userData, 'playbooks', 'agent-1.json'),
				JSON.stringify({ playbooks: [otherPlaybook] })
			);
		});

		it('removes the folder and the saved playbook, and records the launch as failed', async () => {
			const host = launchHost({
				startAutoRun: vi.fn(async () => ({ success: false, error: 'Session agent-1 not found' })),
			});

			await expect(launchMarketplacePlaybook(launchRequest(), host)).rejects.toThrow(
				'The Auto Run did not start: Session agent-1 not found'
			);

			expect(fs.readdirSync(root)).toEqual([]);
			expect(savedPlaybooks()).toEqual([otherPlaybook]);
			expect(launchRecords()).toEqual([
				expect.objectContaining({
					status: 'failed',
					finishedAt: NOW.getTime(),
					cleanup: 'done',
					folderRelativePath: LAUNCH_FOLDER,
				}),
			]);
		});

		it('frees the agent for the next launch', async () => {
			await expect(
				launchMarketplacePlaybook(
					launchRequest(),
					launchHost({ startAutoRun: vi.fn(async () => ({ success: false, error: 'Timeout' })) })
				)
			).rejects.toThrow('The Auto Run did not start: Timeout');

			await expect(launchMarketplacePlaybook(launchRequest(), launchHost())).resolves.toMatchObject(
				{ folderRelativePath: LAUNCH_FOLDER }
			);
			expect(launchRecords().map((record) => record.status)).toEqual(['failed', 'running']);
		});

		it('says so when the desktop app gives no reason', async () => {
			const host = launchHost({ startAutoRun: vi.fn(async () => ({ success: false })) });

			await expect(launchMarketplacePlaybook(launchRequest(), host)).rejects.toThrow(
				'The Auto Run did not start: the desktop app gave no reason'
			);
		});

		it('removes the saved playbook even when the user asked to keep it', async () => {
			const host = launchHost({
				startAutoRun: vi.fn(async () => ({ success: false, error: 'No Auto Run folder' })),
			});

			await expect(
				launchMarketplacePlaybook(launchRequest({ keepSavedPlaybook: true }), host)
			).rejects.toThrow('The Auto Run did not start: No Auto Run folder');

			expect(savedPlaybooks()).toEqual([otherPlaybook]);
			expect(fs.readdirSync(root)).toEqual([]);
		});

		it('throws the error of a starter that throws, after the same undo', async () => {
			const failure = new Error('renderer went away');
			const host = launchHost({
				startAutoRun: vi.fn(async () => {
					throw failure;
				}),
			});

			await expect(launchMarketplacePlaybook(launchRequest(), host)).rejects.toBe(failure);

			expect(fs.readdirSync(root)).toEqual([]);
			expect(savedPlaybooks()).toEqual([otherPlaybook]);
			expect(launchRecords()[0]).toMatchObject({ status: 'failed', cleanup: 'done' });
		});

		it('reports a folder it could not remove, and still throws why the launch stopped', async () => {
			const host = launchHost({
				startAutoRun: vi.fn(async (_sessionId, config) => {
					// Something put a file where the launch folder was.
					const folder = path.join(root, config.documents[0].filename.split('/')[0]);
					fs.rmSync(folder, { recursive: true });
					fs.writeFileSync(folder, 'not a folder');
					return { success: false, error: 'Session agent-1 not found' };
				}),
			});

			await expect(launchMarketplacePlaybook(launchRequest(), host)).rejects.toThrow(
				'The Auto Run did not start: Session agent-1 not found'
			);

			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.any(MarketplaceLaunchCleanupError),
				expect.objectContaining({ operation: 'marketplace:undoLaunch', folder: LAUNCH_FOLDER })
			);
			expect(fs.readFileSync(path.join(root, LAUNCH_FOLDER), 'utf-8')).toBe('not a folder');
			expect(savedPlaybooks()).toEqual([otherPlaybook]);
			const [record] = launchRecords();
			expect(record.status).toBe('failed');
			expect(record).not.toHaveProperty('cleanup');
		});

		it('removes what an import that fails wrote, and writes no record', async () => {
			// A document that cannot be read fails it, as every document does here.
			fs.rmSync(path.join(source, '1_SCOPE.md'));
			fs.rmSync(path.join(source, '2_SWEEP.md'));
			const host = launchHost();

			await expect(launchMarketplacePlaybook(launchRequest(), host)).rejects.toThrow(
				'Failed to import any documents for playbook: Market Research'
			);

			expect(fs.readdirSync(root)).toEqual([]);
			expect(savedPlaybooks()).toEqual([otherPlaybook]);
			expect(launchRecords()).toEqual([]);
			expect(host.startAutoRun).not.toHaveBeenCalled();
		});
	});

	describe('on an SSH remote', () => {
		const REMOTE_ROOT = '/home/dev/project/.maestro/playbooks';
		const SSH_ARGS = ['-p', '22', 'dev@build.example.com'];
		const remote = {
			id: 'remote-1',
			name: 'Build box',
			host: 'build.example.com',
			port: 22,
			username: 'dev',
			privateKeyPath: '~/.ssh/id_ed25519',
			enabled: true,
		} as SshRemoteConfig;

		/** Every remote command sent, in order (remote-fs appends it to the ssh arguments) */
		const sentCommands = (): string[] =>
			mockExecFileNoThrow.mock.calls.map((call) => (call[1] as string[]).at(-1) as string);

		const remoteRequest = (overrides: Partial<PlaybookLaunchRequest> = {}) =>
			launchRequest({ autoRunFolderPath: REMOTE_ROOT, sshRemoteId: 'remote-1', ...overrides });

		beforeEach(() => {
			mockGetSshRemoteById.mockImplementation((id: string) =>
				id === remote.id ? remote : undefined
			);
			// remote-fs appends the command to the array it gets, so each call needs its own.
			mockBuildSshArgs.mockImplementation(() => [...SSH_ARGS]);
			mockExecFileNoThrow.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		});

		it('creates the launch folder exclusively on the remote, imports there and records the remote', async () => {
			const host = launchHost();

			const result = await launchMarketplacePlaybook(remoteRequest(), host);

			expect(result.folderRelativePath).toBe(LAUNCH_FOLDER);
			const target = `${REMOTE_ROOT}/${LAUNCH_FOLDER}`;
			expect(sentCommands().slice(0, 2)).toEqual([
				`mkdir -p '${REMOTE_ROOT}'`,
				// No -p: the folder is created only when nothing is there yet.
				`mkdir  '${target}'`,
			]);
			// The document goes over stdin, base64 encoded, exactly as fetched.
			const write = mockExecFileNoThrow.mock.calls.find(
				(call) => (call[1] as string[]).at(-1) === `base64 -d > '${target}/1_SCOPE.md'`
			);
			expect(write).toBeDefined();
			const { input } = write![3] as { input: string };
			expect(Buffer.from(input, 'base64').toString('utf-8')).toBe(SCOPE_DOC);
			expect(sentCommands()).toContain(`base64 -d > '${target}/assets/helper.sh'`);
			// Nothing lands in a folder of the same name on this computer.
			expect(fs.readdirSync(root)).toEqual([]);

			expect(launchRecords()[0]).toMatchObject({
				autoRunFolderPath: REMOTE_ROOT,
				sshRemoteId: 'remote-1',
				folderRelativePath: LAUNCH_FOLDER,
				status: 'running',
			});
			expect(startedConfig(host).documents).toEqual([
				{ filename: `${LAUNCH_FOLDER}/1_SCOPE`, resetOnCompletion: false },
				{ filename: `${LAUNCH_FOLDER}/2_SWEEP`, resetOnCompletion: true },
			]);
		});

		it('takes the next name when the launch folder already exists on the remote', async () => {
			mockExecFileNoThrow.mockImplementation(async (_command: string, args: string[]) =>
				args.at(-1) === `mkdir  '${REMOTE_ROOT}/${LAUNCH_FOLDER}'`
					? {
							stdout: '',
							stderr: `mkdir: cannot create directory '${REMOTE_ROOT}/${LAUNCH_FOLDER}': File exists`,
							exitCode: 1,
						}
					: { stdout: '', stderr: '', exitCode: 0 }
			);

			const result = await launchMarketplacePlaybook(remoteRequest(), launchHost());

			expect(result.folderRelativePath).toBe(`${LAUNCH_FOLDER}-2`);
			expect(sentCommands()).toContain(`mkdir  '${REMOTE_ROOT}/${LAUNCH_FOLDER}-2'`);
		});

		it('stops on any other failure to create the remote launch folder', async () => {
			mockExecFileNoThrow.mockImplementation(async (_command: string, args: string[]) =>
				args.at(-1)?.startsWith('mkdir  ')
					? {
							stdout: '',
							stderr: `mkdir: cannot create directory '${REMOTE_ROOT}/${LAUNCH_FOLDER}': Permission denied`,
							exitCode: 1,
						}
					: { stdout: '', stderr: '', exitCode: 0 }
			);
			const host = launchHost();

			await expect(launchMarketplacePlaybook(remoteRequest(), host)).rejects.toThrow(
				`Failed to create remote directory: Permission denied: ${REMOTE_ROOT}/${LAUNCH_FOLDER}`
			);
			expect(savedPlaybooks()).toEqual([]);
			expect(launchRecords()).toEqual([]);
			expect(host.startAutoRun).not.toHaveBeenCalled();
		});

		it('deletes the remote launch folder over SSH when its Auto Run does not start', async () => {
			const host = launchHost({
				startAutoRun: vi.fn(async () => ({ success: false, error: 'Timeout' })),
			});

			await expect(launchMarketplacePlaybook(remoteRequest(), host)).rejects.toThrow(
				'The Auto Run did not start: Timeout'
			);

			const escaped = `'${REMOTE_ROOT}/${LAUNCH_FOLDER}'`;
			expect(sentCommands().at(-1)).toBe(
				`[ -L ${escaped} ] && exit 4; [ -e ${escaped} ] || exit 3; ` +
					`[ -d ${escaped} ] || exit 5; rm -rf -- ${escaped}`
			);
			expect(savedPlaybooks()).toEqual([]);
			expect(launchRecords()[0]).toMatchObject({ status: 'failed', cleanup: 'done' });
		});

		it.each([
			['missing', undefined],
			['disabled', { ...remote, enabled: false }],
		])('refuses a %s SSH remote without opening a connection', async (_state, config) => {
			mockGetSshRemoteById.mockReturnValue(config);
			const host = launchHost();

			await expect(launchMarketplacePlaybook(remoteRequest(), host)).rejects.toThrow(
				'SSH remote not found or disabled: remote-1'
			);
			expect(mockExecFileNoThrow).not.toHaveBeenCalled();
			expectNothingLaunched(host);
		});

		it('refuses a remote Auto Run folder that is neither absolute nor under the remote home', async () => {
			const host = launchHost();

			await expect(
				launchMarketplacePlaybook(remoteRequest({ autoRunFolderPath: 'project/playbooks' }), host)
			).rejects.toThrow(
				'The Auto Run folder must be an absolute path on the SSH remote: project/playbooks'
			);
			expect(mockGetSshRemoteById).not.toHaveBeenCalled();
			expect(mockExecFileNoThrow).not.toHaveBeenCalled();
		});

		it('refuses a playbook that requires maestro-cli, without asking whether it is installed here', async () => {
			writeManifest([
				manifestEntry({ launch: { ...LAUNCH, preconditions: { maestroCli: 'required' } } }),
			]);
			const host = launchHost();

			await expect(launchMarketplacePlaybook(remoteRequest(), host)).rejects.toThrow(
				'This playbook drives Maestro through maestro-cli, which is not available on remote agents.'
			);
			expect(host.isMaestroCliInstalled).not.toHaveBeenCalled();
			expect(mockExecFileNoThrow).not.toHaveBeenCalled();
		});
	});
});
