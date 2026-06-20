import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	addHistoryEntry,
	deleteAgentConfigValue,
	deleteSettingValue,
	getAgentCustomPath,
	getConfigDirectory,
	getSessionById,
	getSessionsByGroup,
	readAgentConfig,
	readAgentConfigs,
	readAgentConfigValue,
	readGroups,
	readHistory,
	readHistoryPaginated,
	readSessions,
	readSettingValue,
	readSettings,
	resolveAgentId,
	resolveGroupId,
	writeAgentConfigValue,
	writeSettingValue,
} from '../../cli/services/storage';
import { HISTORY_VERSION, MAX_ENTRIES_PER_SESSION, sanitizeSessionId } from '../../shared/history';
import type { Group, HistoryEntry, SessionInfo } from '../../shared/types';

const osMocks = vi.hoisted(() => ({
	homeDir: '',
	platform: 'darwin' as NodeJS.Platform,
}));

vi.mock('os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('os')>();
	return {
		...actual,
		platform: vi.fn(() => osMocks.platform),
		homedir: vi.fn(() => osMocks.homeDir),
	};
});

const originalEnv = { ...process.env };

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		id: 'session-alpha',
		name: 'Alpha Session',
		toolType: 'claude-code',
		cwd: '/repo/alpha',
		projectRoot: '/repo/alpha',
		groupId: 'group-alpha',
		...overrides,
	};
}

function group(overrides: Partial<Group> = {}): Group {
	return {
		id: 'group-alpha',
		name: 'Alpha Group',
		emoji: 'A',
		collapsed: false,
		...overrides,
	};
}

function historyEntry(id: string, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		id,
		type: 'AUTO',
		timestamp: 1_700_000_000_000,
		summary: `History ${id}`,
		projectPath: '/repo/alpha',
		sessionId: 'session-alpha',
		...overrides,
	};
}

function writeJson(filePath: string, value: unknown) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function readJson<T>(filePath: string): T {
	return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

describe('CLI storage integration', () => {
	let tempRoot: string;

	function configFile(filename: string) {
		return path.join(getConfigDirectory(), filename);
	}

	function historyFile(sessionId: string) {
		return path.join(getConfigDirectory(), 'history', `${sanitizeSessionId(sessionId)}.json`);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		process.env = { ...originalEnv };
		tempRoot = fs.mkdtempSync(
			path.join(process.env.TMPDIR || '/tmp', 'maestro-cli-storage-integration-')
		);
		osMocks.homeDir = path.join(tempRoot, 'home');
		osMocks.platform = 'darwin';
		fs.mkdirSync(osMocks.homeDir, { recursive: true });
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		if (tempRoot) {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it('resolves platform config directories without touching the real home directory', () => {
		expect(getConfigDirectory()).toBe(
			path.join(osMocks.homeDir, 'Library', 'Application Support', 'Maestro')
		);

		osMocks.platform = 'win32';
		process.env.APPDATA = path.join(tempRoot, 'roaming');
		expect(getConfigDirectory()).toBe(path.join(tempRoot, 'roaming', 'Maestro'));
		delete process.env.APPDATA;
		expect(getConfigDirectory()).toBe(path.join(osMocks.homeDir, 'AppData', 'Roaming', 'Maestro'));

		osMocks.platform = 'linux';
		process.env.XDG_CONFIG_HOME = path.join(tempRoot, 'xdg');
		expect(getConfigDirectory()).toBe(path.join(tempRoot, 'xdg', 'Maestro'));
		delete process.env.XDG_CONFIG_HOME;
		expect(getConfigDirectory()).toBe(path.join(osMocks.homeDir, '.config', 'Maestro'));
	});

	it('reads sessions, groups, nested settings, agent configs, and partial identifiers', () => {
		expect(writeSettingValue('bootstrap.enabled', true)).toBe(true);
		expect(readSettingValue('bootstrap.enabled')).toBe(true);
		fs.writeFileSync(configFile('maestro-sessions.json'), '{bad json', 'utf-8');
		expect(() => readSessions()).toThrow();

		const sessions = [
			session({ id: 'alpha-111', name: 'Alpha One', groupId: 'group-alpha' }),
			session({ id: 'alpha-222', name: 'Alpha Two', groupId: 'group-beta' }),
			session({ id: 'bravo-333', name: 'Bravo', groupId: 'group-beta' }),
		];
		const groups = [
			group({ id: 'group-alpha', name: 'Alpha Group' }),
			group({ id: 'group-beta', name: 'Beta Group' }),
		];
		writeJson(configFile('maestro-sessions.json'), { sessions });
		writeJson(configFile('maestro-groups.json'), { groups });
		writeJson(configFile('maestro-settings.json'), {
			activeThemeId: 'dracula',
			encoreFeatures: { directorNotes: true },
		});
		writeJson(configFile('maestro-agent-configs.json'), {
			configs: {
				'claude-code': { customPath: '/bin/claude', model: 'opus' },
				codex: { customPath: '', model: 'gpt-5' },
			},
		});

		expect(readSessions().map((item) => item.id)).toEqual(['alpha-111', 'alpha-222', 'bravo-333']);
		expect(readGroups().map((item) => item.name)).toEqual(['Alpha Group', 'Beta Group']);
		expect(readSettings()).toMatchObject({ activeThemeId: 'dracula' });
		expect(readSettingValue('encoreFeatures.directorNotes')).toBe(true);
		expect(readSettingValue('encoreFeatures.missing')).toBeUndefined();
		expect(readSettingValue('activeThemeId.color')).toBeUndefined();
		expect(writeSettingValue('activeThemeId.color', 'blue')).toBe(true);
		expect(readSettingValue('activeThemeId.color')).toBe('blue');
		expect(writeSettingValue('encoreFeatures.directorNotes', false)).toBe(true);
		expect(readSettingValue('encoreFeatures.directorNotes')).toBe(false);
		expect(deleteSettingValue('encoreFeatures.directorNotes')).toBe(true);
		expect(deleteSettingValue('encoreFeatures.directorNotes')).toBe(false);
		expect(deleteSettingValue('missing.deep')).toBe(false);
		expect(deleteSettingValue('activeThemeId.color')).toBe(true);

		expect(readAgentConfigs()).toHaveProperty('claude-code');
		expect(readAgentConfig('claude-code')).toMatchObject({ model: 'opus' });
		expect(readAgentConfig('missing-agent')).toEqual({});
		expect(readAgentConfigValue('claude-code', 'model')).toBe('opus');
		expect(getAgentCustomPath('claude-code')).toBe('/bin/claude');
		expect(getAgentCustomPath('codex')).toBeUndefined();
		expect(writeAgentConfigValue('opencode', 'customPath', '/bin/opencode')).toBe(true);
		expect(readAgentConfigValue('opencode', 'customPath')).toBe('/bin/opencode');
		expect(deleteAgentConfigValue('opencode', 'customPath')).toBe(true);
		expect(deleteAgentConfigValue('opencode', 'customPath')).toBe(false);

		expect(resolveAgentId('bravo')).toBe('bravo-333');
		expect(() => resolveAgentId('alpha')).toThrow("Ambiguous agent ID 'alpha'");
		expect(() => resolveAgentId('missing')).toThrow('Agent not found: missing');
		expect(resolveGroupId('group-alpha')).toBe('group-alpha');
		expect(resolveGroupId('group-b')).toBe('group-beta');
		expect(() => resolveGroupId('group')).toThrow("Ambiguous group ID 'group'");
		expect(() => resolveGroupId('missing')).toThrow('Group not found: missing');
		expect(getSessionById('bravo')).toMatchObject({ id: 'bravo-333' });
		expect(getSessionById('alpha')).toBeUndefined();
		expect(getSessionsByGroup('group-alpha').map((item) => item.id)).toEqual(['alpha-111']);
		expect(getSessionsByGroup('group-b').map((item) => item.id)).toEqual([
			'alpha-222',
			'bravo-333',
		]);
		expect(getSessionsByGroup('missing')).toEqual([]);
	});

	it('reads and writes legacy history files with filtering and pagination', () => {
		fs.mkdirSync(getConfigDirectory(), { recursive: true });
		writeJson(configFile('maestro-history.json'), {
			entries: [
				historyEntry('legacy-new', { timestamp: 300, sessionId: 'session-alpha' }),
				historyEntry('legacy-beta', {
					timestamp: 200,
					projectPath: '/repo/beta',
					sessionId: 'session-beta',
				}),
				historyEntry('legacy-old', { timestamp: 100, sessionId: 'session-alpha' }),
			],
		});

		expect(readHistory('/repo/alpha', 'session-alpha').map((entry) => entry.id)).toEqual([
			'legacy-new',
			'legacy-old',
		]);
		expect(
			readHistoryPaginated({
				projectPath: '/repo/alpha',
				pagination: { limit: 1, offset: 1 },
			})
		).toMatchObject({
			entries: [expect.objectContaining({ id: 'legacy-old' })],
			total: 2,
			limit: 1,
			offset: 1,
			hasMore: false,
		});

		addHistoryEntry(historyEntry('legacy-added', { timestamp: 400 }));
		expect(
			readJson<{ entries: HistoryEntry[] }>(configFile('maestro-history.json')).entries.map(
				(entry) => entry.id
			)
		).toEqual(['legacy-added', 'legacy-new', 'legacy-beta', 'legacy-old']);
	});

	it('reads and writes migrated per-session history files with corruption recovery', () => {
		writeJson(configFile('history-migrated.json'), {
			migratedAt: Date.now(),
			version: HISTORY_VERSION,
			legacyEntryCount: 3,
			sessionsMigrated: 2,
		});
		writeJson(historyFile('session/alpha'), {
			version: HISTORY_VERSION,
			sessionId: 'session/alpha',
			projectPath: '/repo/alpha',
			entries: [
				historyEntry('alpha-new', { timestamp: 300, sessionId: 'session/alpha' }),
				historyEntry('alpha-old', { timestamp: 100, sessionId: 'session/alpha' }),
			],
		});
		writeJson(historyFile('session-beta'), {
			version: HISTORY_VERSION,
			sessionId: 'session-beta',
			projectPath: '/repo/beta',
			entries: [
				historyEntry('beta-entry', {
					timestamp: 200,
					projectPath: '/repo/beta',
					sessionId: 'session-beta',
				}),
			],
		});
		fs.writeFileSync(historyFile('broken-session'), '{not json', 'utf-8');

		expect(readHistory(undefined, 'session/alpha').map((entry) => entry.id)).toEqual([
			'alpha-new',
			'alpha-old',
		]);
		expect(readHistory(undefined, 'missing-session')).toEqual([]);
		expect(readHistory(undefined, 'broken-session')).toEqual([]);
		expect(readHistory('/repo/alpha').map((entry) => entry.id)).toEqual(['alpha-new', 'alpha-old']);
		expect(readHistory().map((entry) => entry.id)).toEqual([
			'alpha-new',
			'beta-entry',
			'alpha-old',
		]);

		addHistoryEntry(historyEntry('skipped-no-session', { sessionId: undefined }));
		expect(readHistory().map((entry) => entry.id)).toEqual([
			'alpha-new',
			'beta-entry',
			'alpha-old',
		]);

		const overflowEntries = Array.from({ length: MAX_ENTRIES_PER_SESSION }, (_, index) =>
			historyEntry(`overflow-${index}`, {
				timestamp: index,
				projectPath: '/repo/overflow',
				sessionId: 'overflow-session',
			})
		);
		writeJson(historyFile('overflow-session'), {
			version: HISTORY_VERSION,
			sessionId: 'overflow-session',
			projectPath: '/repo/overflow',
			entries: overflowEntries,
		});
		addHistoryEntry(
			historyEntry('overflow-new', {
				projectPath: '/repo/overflow-renamed',
				sessionId: 'overflow-session',
			})
		);
		const overflowData = readJson<{ projectPath: string; entries: HistoryEntry[] }>(
			historyFile('overflow-session')
		);
		expect(overflowData.projectPath).toBe('/repo/overflow-renamed');
		expect(overflowData.entries).toHaveLength(MAX_ENTRIES_PER_SESSION);
		expect(overflowData.entries[0].id).toBe('overflow-new');

		addHistoryEntry(
			historyEntry('broken-recovered', {
				projectPath: '/repo/recovered',
				sessionId: 'broken-session',
			})
		);
		expect(readHistory(undefined, 'broken-session')).toEqual([
			expect.objectContaining({ id: 'broken-recovered' }),
		]);

		fs.rmSync(path.join(getConfigDirectory(), 'history'), { recursive: true, force: true });
		expect(readHistory()).toEqual([]);
		addHistoryEntry(
			historyEntry('fresh-migrated', {
				projectPath: '/repo/fresh',
				sessionId: 'fresh-session',
			})
		);
		expect(readHistory(undefined, 'fresh-session')).toEqual([
			expect.objectContaining({ id: 'fresh-migrated' }),
		]);

		const expectedWriteWarning = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		fs.mkdirSync(historyFile('blocked-session'), { recursive: true });
		addHistoryEntry(
			historyEntry('blocked-write', {
				projectPath: '/repo/blocked',
				sessionId: 'blocked-session',
			})
		);
		expect(expectedWriteWarning).not.toHaveBeenCalled();
		expect(readHistory(undefined, 'blocked-session')).toEqual([
			expect.objectContaining({ id: 'blocked-write' }),
		]);
		expectedWriteWarning.mockRestore();
	});
});
