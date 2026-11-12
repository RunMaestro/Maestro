/**
 * Service-level tests for src/main/services/marketplace-service.ts. The manifest and import flows
 * are tested through the IPC handler (src/__tests__/main/ipc/handlers/marketplace.test.ts).
 *
 * `deleteLaunchFolder` is Launch cleanup's only delete. Local agents run against a real temp
 * folder, so a refusal is proven by what is still on disk. SSH agents run the real remote-fs code
 * with only the SSH transport mocked, so the tests see the exact remote command.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SshRemoteConfig } from '../../../shared/types';

const { mockLogger, mockGetSshRemoteById, mockExecFileNoThrow, mockBuildSshArgs } = vi.hoisted(
	() => ({
		mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		mockGetSshRemoteById: vi.fn(),
		mockExecFileNoThrow: vi.fn(),
		mockBuildSshArgs: vi.fn(),
	})
);

vi.mock('../../../main/utils/logger', () => ({ logger: mockLogger }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/stores/getters', () => ({ getSshRemoteById: mockGetSshRemoteById }));
// The SSH transport only. Even SSH discovery stays off the real host.
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: mockExecFileNoThrow }));
vi.mock('../../../main/utils/cliDetection', () => ({ resolveSshPath: vi.fn(async () => 'ssh') }));
vi.mock('../../../main/ssh-remote-manager', () => ({
	sshRemoteManager: { buildSshArgs: mockBuildSshArgs },
}));

import { deleteLaunchFolder } from '../../../main/services/marketplace-service';
import { MarketplaceLaunchCleanupError } from '../../../shared/marketplace-types';

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
