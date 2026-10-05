import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveMaestroPaths } from '../resolve';

/**
 * Every case pins `MAESTRO_USER_DATA` (or passes an explicit `env`) so the LIVE
 * value an agent shell exports can never leak in.
 *
 * A custom sync path is validated by the desktop's rules, which reject `/tmp`
 * and `/var` (where `os.tmpdir()` lives on macOS), so the sync paths below are
 * synthetic absolute paths that are never created. The resolver must not need
 * them to exist.
 */
describe('resolveMaestroPaths', () => {
	let tempDir: string;
	let userDataDir: string;
	const syncDir = path.join(path.parse(os.tmpdir()).root, 'Users', 'someone', 'Sync', 'Maestro');

	function writeBootstrap(content: string): void {
		fs.mkdirSync(userDataDir, { recursive: true });
		fs.writeFileSync(path.join(userDataDir, 'maestro-bootstrap.json'), content);
	}

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-paths-'));
		userDataDir = path.join(tempDir, 'Maestro');
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('uses userData for everything when there is no bootstrap file', () => {
		const paths = resolveMaestroPaths({
			env: {},
			homedir: tempDir,
			platform: 'linux',
			isPackaged: true,
			isDevelopment: false,
		});
		const expectedUserData = path.join(tempDir, '.config', 'Maestro');

		expect(paths).toEqual({
			userDataDir: expectedUserData,
			productionDataDir: expectedUserData,
			bootstrapFile: path.join(expectedUserData, 'maestro-bootstrap.json'),
			syncDir: expectedUserData,
			syncDirSource: 'userData',
			sessionsFile: path.join(expectedUserData, 'maestro-sessions.json'),
			groupsFile: path.join(expectedUserData, 'maestro-groups.json'),
			settingsFile: path.join(expectedUserData, 'maestro-settings.json'),
			agentConfigsFile: path.join(expectedUserData, 'maestro-agent-configs.json'),
			historyDir: path.join(expectedUserData, 'history'),
			statsFile: path.join(expectedUserData, 'stats.db'),
			groupChatsDir: path.join(expectedUserData, 'group-chats'),
			sessionImagesDir: path.join(expectedUserData, 'session-images'),
			cliServerFile: path.join(expectedUserData, 'cli-server.json'),
		});
	});

	it('moves the synced stores to customSyncPath and keeps the rest under userData', () => {
		writeBootstrap(JSON.stringify({ customSyncPath: syncDir }));

		const paths = resolveMaestroPaths({ env: { MAESTRO_USER_DATA: userDataDir } });

		expect(paths.syncDir).toBe(syncDir);
		expect(paths.syncDirSource).toBe('customSyncPath');
		expect(paths.customSyncPathRejection).toBeUndefined();
		expect(paths.sessionsFile).toBe(path.join(syncDir, 'maestro-sessions.json'));
		expect(paths.groupsFile).toBe(path.join(syncDir, 'maestro-groups.json'));
		expect(paths.settingsFile).toBe(path.join(syncDir, 'maestro-settings.json'));
		expect(paths.groupChatsDir).toBe(path.join(syncDir, 'group-chats'));
		expect(paths.sessionImagesDir).toBe(path.join(syncDir, 'session-images'));

		expect(paths.agentConfigsFile).toBe(path.join(userDataDir, 'maestro-agent-configs.json'));
		expect(paths.historyDir).toBe(path.join(userDataDir, 'history'));
		expect(paths.statsFile).toBe(path.join(userDataDir, 'stats.db'));
		expect(paths.cliServerFile).toBe(path.join(userDataDir, 'cli-server.json'));
	});

	it('reports a customSyncPath that does not exist yet, without creating it', () => {
		// The desktop creates the directory on startup, so it is still where
		// the stores will live. Falling back here would read the wrong files.
		expect(fs.existsSync(syncDir)).toBe(false);
		writeBootstrap(JSON.stringify({ customSyncPath: syncDir }));

		const paths = resolveMaestroPaths({ env: { MAESTRO_USER_DATA: userDataDir } });

		expect(paths.syncDir).toBe(syncDir);
		expect(paths.syncDirSource).toBe('customSyncPath');
		expect(fs.existsSync(syncDir)).toBe(false);
	});

	it('falls back to userData when the desktop would reject customSyncPath', () => {
		writeBootstrap(JSON.stringify({ customSyncPath: 'relative/sync' }));

		const paths = resolveMaestroPaths({ env: { MAESTRO_USER_DATA: userDataDir } });

		expect(paths.syncDir).toBe(userDataDir);
		expect(paths.syncDirSource).toBe('userData');
		expect(paths.customSyncPathRejection).toBe('Custom sync path must be absolute: relative/sync');
		expect(paths.sessionsFile).toBe(path.join(userDataDir, 'maestro-sessions.json'));
	});

	it('ignores a malformed bootstrap file', () => {
		writeBootstrap('{invalid json}');

		const paths = resolveMaestroPaths({ env: { MAESTRO_USER_DATA: userDataDir } });

		expect(paths.syncDir).toBe(userDataDir);
		expect(paths.syncDirSource).toBe('userData');
		expect(paths.customSyncPathRejection).toBeUndefined();
	});

	it('ignores an empty or non-string customSyncPath', () => {
		writeBootstrap(JSON.stringify({ customSyncPath: '' }));
		expect(resolveMaestroPaths({ env: { MAESTRO_USER_DATA: userDataDir } }).syncDirSource).toBe(
			'userData'
		);

		writeBootstrap(JSON.stringify({ customSyncPath: 42 }));
		expect(resolveMaestroPaths({ env: { MAESTRO_USER_DATA: userDataDir } }).syncDirSource).toBe(
			'userData'
		);
	});

	it('reads a bootstrap file that starts with a BOM', () => {
		writeBootstrap('﻿' + JSON.stringify({ customSyncPath: syncDir }));

		const paths = resolveMaestroPaths({ env: { MAESTRO_USER_DATA: userDataDir } });

		expect(paths.syncDir).toBe(syncDir);
	});

	describe('dev mode', () => {
		it('keeps agent configs in the production directory the dev redirect came from', () => {
			const paths = resolveMaestroPaths({
				env: {},
				homedir: tempDir,
				platform: 'linux',
				isPackaged: false,
				isDevelopment: true,
			});
			const root = path.join(tempDir, '.config');

			expect(paths.userDataDir).toBe(path.join(root, 'maestro-dev'));
			expect(paths.productionDataDir).toBe(path.join(root, 'maestro'));
			expect(paths.agentConfigsFile).toBe(path.join(root, 'maestro', 'maestro-agent-configs.json'));
			expect(paths.sessionsFile).toBe(path.join(root, 'maestro-dev', 'maestro-sessions.json'));
			expect(paths.historyDir).toBe(path.join(root, 'maestro-dev', 'history'));
		});

		it('maps an inherited maestro-dev MAESTRO_USER_DATA back to its production sibling', () => {
			// A dev desktop publishes its post-redirect directory to the processes it spawns.
			const devDir = path.join(tempDir, 'maestro-dev');

			const paths = resolveMaestroPaths({ env: { MAESTRO_USER_DATA: devDir } });

			expect(paths.userDataDir).toBe(devDir);
			expect(paths.agentConfigsFile).toBe(
				path.join(tempDir, 'maestro', 'maestro-agent-configs.json')
			);
		});

		it('honors an explicit productionDataPath', () => {
			const prodDir = path.join(tempDir, 'elsewhere');

			const paths = resolveMaestroPaths({
				env: { MAESTRO_USER_DATA: userDataDir },
				productionDataPath: prodDir,
			});

			expect(paths.agentConfigsFile).toBe(path.join(prodDir, 'maestro-agent-configs.json'));
		});
	});
});
