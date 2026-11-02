vi.mock('../../../main/plugins/plugin-scan', async () => await import('../../helpers/pluginScan'));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

import {
	PluginManager,
	type PluginManagerDeps,
	type PluginSandboxLifecycle,
} from '../../../main/plugins/plugin-manager';
import {
	getActivePluginManager,
	setActivePluginManager,
} from '../../../main/plugins/plugin-manager-singleton';
import { PluginAuthorityError } from '../../../main/plugins/plugin-authority';
import { PluginToolRunIdentity } from '../../../main/plugins/plugin-tool-run-identity';
import { PluginToolRunProofFiles } from '../../../main/plugins/plugin-tool-run-proof-file';

describe.skipIf(!['linux', 'darwin'].includes(process.platform))(
	'hardened plugin tool proof storage admission',
	() => {
		let directory: string;
		let runs: PluginToolRunIdentity;
		let files: PluginToolRunProofFiles;
		let manager: PluginManager | undefined;
		let deps: PluginManagerDeps;
		let controller: AbortController;
		let storageAllowed: boolean;

		beforeEach(async () => {
			const root = path.join(fs.realpathSync(process.cwd()), '.maestro', 'proof-storage-tests');
			fs.mkdirSync(root, { recursive: true, mode: 0o700 });
			directory = fs.mkdtempSync(path.join(root, 'fixture-'));
			// Worktree ancestors may be group-writable. Supply only synthetic private
			// ancestor mode facts; the real owner, file IO, lifetime and cleanup run below.
			const ancestors = new Set<string>();
			for (let ancestor = path.dirname(directory); ; ancestor = path.dirname(ancestor)) {
				ancestors.add(ancestor);
				if (path.dirname(ancestor) === ancestor) break;
			}
			const actualLstat = (await vi.importActual<typeof import('fs')>('fs')).lstatSync;
			vi.mocked(fs.lstatSync).mockImplementation(((target: fs.PathLike) => {
				const stat = actualLstat(target);
				return ancestors.has(String(target))
					? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
							mode: stat.mode & ~0o022,
						})
					: stat;
			}) as typeof fs.lstatSync);
			runs = new PluginToolRunIdentity((agentId) => {
				if (agentId !== 'fixture-agent') throw new PluginAuthorityError('PLUGIN_DENIED');
			});
			files = PluginToolRunProofFiles.provision(runs, directory);
			controller = new AbortController();
			storageAllowed = true;
			const sandbox: PluginSandboxLifecycle = {
				start: vi.fn(),
				stop: vi.fn(),
				stopAll: vi.fn(),
				isRunning: () => true,
				runningIds: () => [],
				invokeCommand: () => false,
				invokeTool: vi.fn(),
				captureToolLifetime: () => () => {},
			};
			deps = {
				prepareToolRecordActive: async () => {},
				isEnabled: () => true,
				sandbox,
				toolIdentity: runs,
				toolProofFiles: files,
				assertToolRecordActive: () => {},
				assertToolProofStorageActive: () => {
					if (!storageAllowed) throw new PluginAuthorityError('PLUGIN_DENIED');
				},
			};
		});

		afterEach(() => {
			try {
				setActivePluginManager(null);
				manager?.stopToolAuthority();
				runs?.stop();
				files?.stop();
			} finally {
				manager = undefined;
				if (directory) fs.rmSync(directory, { recursive: true, force: true });
				vi.restoreAllMocks();
			}
		});

		it('rejects a replacement sharing only the proof-file owner before stopping active resources', () => {
			manager = new PluginManager(deps);
			setActivePluginManager(manager, deps.isEnabled);
			const otherRegistry = new PluginToolRunIdentity();
			const candidate = new PluginManager({ ...deps, toolIdentity: otherRegistry });
			const token = runs.issue('fixture-agent');
			try {
				expect(() => setActivePluginManager(candidate, deps.isEnabled)).toThrow(
					expect.objectContaining({ code: 'PLUGIN_CONFLICT' })
				);
				expect(getActivePluginManager()).toBe(manager);
				expect(runs.resolveVerified(token).callerAgentId).toBe('fixture-agent');
				expect(() => files.assertIdentity(runs)).not.toThrow();
			} finally {
				otherRegistry.stop();
			}
		});

		it('revokes a retained proof when live storage policy fails, even if it later recovers', () => {
			manager = new PluginManager(deps);
			const resource = manager.createToolRunProofFile('fixture-agent', {
				signal: controller.signal,
				assertActive: () => {},
			});
			expect(fs.existsSync(resource.runTokenFile)).toBe(true);
			storageAllowed = false;
			expect(() => resource.assertActive()).toThrow(
				expect.objectContaining({ code: 'PLUGIN_DENIED' })
			);
			expect(resource.signal.aborted).toBe(true);
			expect(fs.existsSync(resource.runTokenFile)).toBe(false);
			expect(() =>
				manager!.createToolRunProofFile('fixture-agent', {
					signal: controller.signal,
					assertActive: () => {},
				})
			).toThrow(expect.objectContaining({ code: 'PLUGIN_DENIED' }));
			storageAllowed = true;
			expect(() => resource.assertActive()).toThrow(
				expect.objectContaining({ code: 'PLUGIN_DENIED' })
			);
			expect(resource.signal.aborted).toBe(true);
		});

		it.each(['missing', 'async'] as const)(
			'denies hardened issuance with a %s storage assertion before creating a proof',
			(mode) => {
				deps.assertToolProofStorageActive = mode === 'missing' ? undefined : async () => {};
				manager = new PluginManager(deps);
				const create = vi.spyOn(files, 'create');
				expect(() =>
					manager!.createToolRunProofFile('fixture-agent', {
						signal: controller.signal,
						assertActive: () => {},
					})
				).toThrow(expect.objectContaining({ code: 'PLUGIN_DENIED' }));
				expect(create).not.toHaveBeenCalled();
			}
		);

		it('retains the original bound storage assertion after dependency mutation', () => {
			const checkStorage = vi.fn(function (this: PluginManagerDeps) {
				expect(this).toBe(deps);
				if (!storageAllowed) throw new PluginAuthorityError('PLUGIN_DENIED');
			});
			deps.assertToolProofStorageActive = checkStorage;
			manager = new PluginManager(deps);
			deps.assertToolProofStorageActive = () => {};
			const resource = manager.createToolRunProofFile('fixture-agent', {
				signal: controller.signal,
				assertActive: () => {},
			});
			expect(checkStorage).toHaveBeenCalled();
			storageAllowed = false;
			expect(() => resource.assertActive()).toThrow(
				expect.objectContaining({ code: 'PLUGIN_DENIED' })
			);
			expect(resource.signal.aborted).toBe(true);
		});

		it('still revokes and removes a hardened proof on exact-run cancellation', () => {
			manager = new PluginManager(deps);
			const resource = manager.createToolRunProofFile('fixture-agent', {
				signal: controller.signal,
				assertActive: () => {},
			});
			controller.abort();
			expect(resource.signal.aborted).toBe(true);
			expect(fs.existsSync(resource.runTokenFile)).toBe(false);
			expect(() => resource.assertActive()).toThrow(
				expect.objectContaining({ code: 'PLUGIN_DENIED' })
			);
		});
	}
);
