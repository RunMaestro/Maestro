import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveMaestroPaths } from '../resolve';

describe('resolveMaestroPaths', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-paths-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it('should resolve paths without bootstrap file', () => {
		const expectedUserData = path.join(tempDir, '.config', 'Maestro');
		const paths = resolveMaestroPaths({
			env: {},
			homedir: tempDir,
			platform: 'linux',
			isPackaged: true,
			isDevelopment: false,
		});

		// When no bootstrap file, sync path should equal userData
		expect(paths.userDataDir).toBe(expectedUserData);
		expect(paths.syncDir).toBe(paths.userDataDir);

		// Files should be under syncDir except agentConfigsFile
		expect(paths.sessionsFile).toContain('maestro-sessions.json');
		expect(paths.groupsFile).toContain('maestro-groups.json');
		expect(paths.settingsFile).toContain('maestro-settings.json');

		// Agent configs always under production path
		expect(paths.agentConfigsFile).toBe(path.join(paths.userDataDir, 'maestro-agent-configs.json'));

		// Directories
		expect(paths.historyDir).toContain('history');
		expect(paths.groupChatsDir).toContain('group-chats');
		expect(paths.sessionImagesDir).toContain('session-images');
		expect(paths.cliServerFile).toContain('cli-server.json');
	});

	it('should use custom sync path when configured', () => {
		// Create custom sync directory
		const customSyncDir = path.join(tempDir, 'custom-sync');
		fs.mkdirSync(customSyncDir, { recursive: true });

		// Create bootstrap file
		const userDataDir = path.join(tempDir, '.config', 'Maestro');
		fs.mkdirSync(userDataDir, { recursive: true });
		fs.writeFileSync(
			path.join(userDataDir, 'maestro-bootstrap.json'),
			JSON.stringify({ customSyncPath: customSyncDir })
		);

		const paths = resolveMaestroPaths({
			env: { MAESTRO_USER_DATA: userDataDir },
			homedir: tempDir,
			platform: 'linux',
			isPackaged: true,
			isDevelopment: false,
		});

		expect(paths.userDataDir).toBe(userDataDir);
		expect(paths.syncDir).toBe(customSyncDir);

		// Files under sync path
		expect(paths.sessionsFile).toBe(path.join(customSyncDir, 'maestro-sessions.json'));
		expect(paths.groupsFile).toBe(path.join(customSyncDir, 'maestro-groups.json'));
		expect(paths.settingsFile).toBe(path.join(customSyncDir, 'maestro-settings.json'));

		// Agent configs still under userData
		expect(paths.agentConfigsFile).toBe(path.join(userDataDir, 'maestro-agent-configs.json'));
	});

	it('should fall back to userData when bootstrap points to missing directory', () => {
		const userDataDir = path.join(tempDir, '.config', 'Maestro');
		fs.mkdirSync(userDataDir, { recursive: true });

		// Bootstrap points to non-existent directory
		fs.writeFileSync(
			path.join(userDataDir, 'maestro-bootstrap.json'),
			JSON.stringify({ customSyncPath: path.join(tempDir, 'missing-dir') })
		);

		const paths = resolveMaestroPaths({
			env: { MAESTRO_USER_DATA: userDataDir },
			homedir: tempDir,
			platform: 'linux',
			isPackaged: true,
			isDevelopment: false,
		});

		// Should fall back to userData
		expect(paths.syncDir).toBe(userDataDir);
	});

	it('should ignore malformed bootstrap file', () => {
		const userDataDir = path.join(tempDir, '.config', 'Maestro');
		fs.mkdirSync(userDataDir, { recursive: true });

		// Write invalid JSON
		fs.writeFileSync(path.join(userDataDir, 'maestro-bootstrap.json'), '{invalid json}');

		const paths = resolveMaestroPaths({
			env: { MAESTRO_USER_DATA: userDataDir },
			homedir: tempDir,
			platform: 'linux',
			isPackaged: true,
			isDevelopment: false,
		});

		// Should fall back to userData
		expect(paths.syncDir).toBe(userDataDir);
	});

	it('should keep agent configs in production path even with custom sync path', () => {
		const customSyncDir = path.join(tempDir, 'custom-sync');
		const prodDataDir = path.join(tempDir, '.config', 'Maestro-prod');
		fs.mkdirSync(customSyncDir, { recursive: true });
		fs.mkdirSync(prodDataDir, { recursive: true });

		// Create bootstrap with custom sync
		fs.writeFileSync(
			path.join(prodDataDir, 'maestro-bootstrap.json'),
			JSON.stringify({ customSyncPath: customSyncDir })
		);

		const paths = resolveMaestroPaths({
			env: { MAESTRO_USER_DATA: prodDataDir },
			productionDataPath: prodDataDir,
			homedir: tempDir,
			platform: 'linux',
			isPackaged: true,
			isDevelopment: false,
		});

		// Sync path should be custom
		expect(paths.syncDir).toBe(customSyncDir);

		// Agent configs should be under production path
		expect(paths.agentConfigsFile).toBe(path.join(prodDataDir, 'maestro-agent-configs.json'));
	});

	it('should use productionDataPath for agent configs in dev mode', () => {
		const userDataDir = path.join(tempDir, '.config', 'maestro-dev');
		const prodDataDir = path.join(tempDir, '.config', 'Maestro');
		fs.mkdirSync(userDataDir, { recursive: true });
		fs.mkdirSync(prodDataDir, { recursive: true });

		const paths = resolveMaestroPaths({
			env: { MAESTRO_USER_DATA: userDataDir },
			productionDataPath: prodDataDir,
			homedir: tempDir,
			platform: 'linux',
			isPackaged: true,
			isDevelopment: true,
		});

		// Should use provided production path for agent configs
		expect(paths.agentConfigsFile).toBe(path.join(prodDataDir, 'maestro-agent-configs.json'));
	});
});
