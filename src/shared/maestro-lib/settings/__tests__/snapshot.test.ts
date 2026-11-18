import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	buildSettingsSnapshot,
	ENCORE_FEATURE_DEFAULTS,
	ENCORE_FEATURE_LABELS,
	isEncoreEnabled,
	loadSettingsSnapshot,
	PROMPT_CUSTOMIZATIONS_FILE,
	readSettingsSnapshotFromFiles,
	type MaestroClient,
	type SshRemoteConfig,
} from '../../index';

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-settings-'));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const paths = () => ({
	userDataDir: dir,
	settingsFile: path.join(dir, 'maestro-settings.json'),
	agentConfigsFile: path.join(dir, 'maestro-agent-configs.json'),
});
const write = (name: string, value: unknown) =>
	fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));

const REMOTE = {
	id: 'r1',
	name: 'Build box',
	host: 'build.example.com',
	port: 2222,
	username: 'ci',
	privateKeyPath: '~/.ssh/id',
	enabled: true,
} as SshRemoteConfig;

describe('buildSettingsSnapshot (ST-1)', () => {
	it('folds the settings into display values and masks every secret', () => {
		const snapshot = buildSettingsSnapshot({
			settings: {
				defaultShell: 'zsh',
				defaultSaveToHistory: false,
				defaultShowThinking: 'sticky',
				shellEnvVars: { ANTHROPIC_API_KEY: 'sk-ant-supersecret-1234', EDITOR: 'vim' },
				conductorProfile: 'Direct.',
			},
			agentConfigs: {
				'claude-code': {
					customPath: '/opt/claude',
					customEnvVars: { OPENAI_API_KEY: 'sk-abcdefghijklmnop', MODE: 'x' },
					customArgs: ['--a', '--b'],
				},
				codex: {},
			},
			sshRemotes: [REMOTE, { ...REMOTE, id: 'r2', name: 'Off', port: 22, enabled: false }],
			promptStore: { 'wizard-system': { isModified: true }, 'auto-run': { isModified: false } },
			source: 'host',
		});

		expect(snapshot.defaults).toEqual({
			shell: 'zsh',
			saveToHistory: false,
			thinkingMode: 'sticky',
			envVars: [
				{ key: 'ANTHROPIC_API_KEY', value: '••••••••1234' },
				{ key: 'EDITOR', value: 'vim' },
			],
		});
		expect(snapshot.providers.map((provider) => provider.providerId)).toEqual([
			'claude-code',
			'codex',
		]);
		expect(snapshot.providers[0].entries).toEqual([
			{ key: 'customArgs', value: '--a --b' },
			{ key: 'customEnvVars', value: 'MODE=x, OPENAI_API_KEY=••••••••mnop' },
			{ key: 'customPath', value: '/opt/claude' },
		]);
		expect(snapshot.sshRemotes).toEqual([
			{ id: 'r1', name: 'Build box', target: 'ci@build.example.com:2222', enabled: true },
			{ id: 'r2', name: 'Off', target: 'ci@build.example.com', enabled: false },
		]);
		expect(snapshot.prompts).toEqual([
			{ id: 'auto-run', modified: false },
			{ id: 'wizard-system', modified: true },
		]);
		expect(snapshot.conductorProfile).toBe('Direct.');
		// No secret survives anywhere in what a view prints.
		expect(JSON.stringify(snapshot)).not.toContain('supersecret');
		expect(JSON.stringify(snapshot)).not.toContain('abcdefghijkl');
	});

	it.each([
		{
			key: 'GROK_AUTH',
			label: 'inline JSON',
			value: '{"token":"snapshot-only-secret","nested":{"refresh":"private-tail"}}',
		},
		{ key: 'GROK_AUTH', label: 'malformed JSON', value: '{"token":"snapshot-only-secret' },
		{ key: 'GROK_AUTH', label: 'short value', value: 'tiny' },
		{ key: 'GROK_AUTH', label: 'empty value', value: '' },
		...['GROK_MODELS_BASE_URL', 'GROK_CLI_CHAT_PROXY_BASE_URL', 'GROK_XAI_API_BASE_URL'].flatMap(
			(key) => [
				{
					key,
					label: 'userinfo credentials',
					value: 'https://fixture-user:snapshot-only-secret@gateway.example/v1',
				},
				{
					key,
					label: 'query credentials',
					value: 'https://gateway.example/v1?access=snapshot-only-secret',
				},
				{
					key,
					label: 'arbitrary path credentials',
					value: 'https://gateway.example/snapshot-only-secret',
				},
				{ key, label: 'malformed URL', value: 'https://[invalid/snapshot-only-secret' },
				{ key, label: 'ordinary URL', value: 'https://gateway.example/v1' },
			]
		),
	])('fully masks $key with $label in every snapshot entry path', ({ key, value }) => {
		const snapshot = buildSettingsSnapshot({
			settings: { shellEnvVars: { [key]: value } },
			agentConfigs: { grok: { [key]: value, customEnvVars: { [key]: value } } },
			sshRemotes: [],
			promptStore: {},
			source: 'host',
		});

		// Exact display values catch leaked suffixes from either keyless masker call.
		expect(snapshot.defaults.envVars).toEqual([{ key, value: '••••••••' }]);
		const entries = snapshot.providers[0].entries;
		expect(entries.find((entry) => entry.key === 'customEnvVars')).toEqual({
			key: 'customEnvVars',
			value: `${key}=••••••••`,
		});
		// Direct blank config entries are omitted; nested environment blanks remain visible.
		expect(entries.find((entry) => entry.key === key)).toEqual(
			value === '' ? undefined : { key, value: '••••••••' }
		);
		const serialized = JSON.stringify(snapshot);
		expect(serialized).not.toContain('snapshot-only-secret');
		if (value !== '') expect(serialized).not.toContain(JSON.stringify(value).slice(1, -1));
	});

	it('reads a setting the host never held as the desktop default', () => {
		const snapshot = buildSettingsSnapshot({
			settings: {},
			agentConfigs: {},
			sshRemotes: [],
			promptStore: {},
			source: 'files',
		});
		expect(snapshot.defaults).toEqual({ saveToHistory: true, thinkingMode: 'off', envVars: [] });
		expect(snapshot.encore).toEqual(ENCORE_FEATURE_DEFAULTS);
	});

	it('resolves Encore flags through resolveEncoreFeatures: a flag never saved takes its default', () => {
		const snapshot = buildSettingsSnapshot({
			settings: { encoreFeatures: { maestroCue: false, pianola: true, symphony: 'yes' } },
			agentConfigs: {},
			sshRemotes: [],
			promptStore: {},
			source: 'files',
		});
		expect(snapshot.encore.maestroCue).toBe(false);
		expect(snapshot.encore.pianola).toBe(true);
		// Only a real boolean overrides: a string falls back to the default.
		expect(snapshot.encore.symphony).toBe(ENCORE_FEATURE_DEFAULTS.symphony);
		expect(snapshot.encore.directorNotes).toBe(ENCORE_FEATURE_DEFAULTS.directorNotes);
	});

	it('labels every Encore flag', () => {
		expect(Object.keys(ENCORE_FEATURE_LABELS).sort()).toEqual(
			Object.keys(ENCORE_FEATURE_DEFAULTS).sort()
		);
	});
});

describe('isEncoreEnabled (ST-2)', () => {
	it('answers from the flags, and from the defaults when there are none yet', () => {
		expect(isEncoreEnabled({ maestroCue: false }, 'maestroCue')).toBe(false);
		expect(isEncoreEnabled({ pianola: true }, 'pianola')).toBe(true);
		expect(isEncoreEnabled(undefined, 'maestroCue')).toBe(true);
		expect(isEncoreEnabled(undefined, 'pianola')).toBe(false);
		expect(isEncoreEnabled({}, 'plugins')).toBe(false);
	});
});

describe('readSettingsSnapshotFromFiles', () => {
	it('keeps Grok secrets opaque while preserving ordinary settings and other provider tails', () => {
		write('maestro-settings.json', {
			defaultShell: 'bash',
			defaultSaveToHistory: false,
			conductorProfile: 'Be brief.',
			shellEnvVars: { GROK_AUTH: '{"token":"file-only-secret"}', EDITOR: 'vim' },
		});
		write('maestro-agent-configs.json', {
			configs: {
				grok: {
					customEnvVars: {
						GROK_XAI_API_BASE_URL: 'https://gateway.example/file-only-secret',
						MODE: 'fixture',
					},
				},
				codex: {
					model: 'fixture-model',
					customEnvVars: {
						OPENAI_API_KEY: 'sk-codex-fixture-1234',
						OPENAI_BASE_URL: 'https://api.example/v1',
					},
				},
				'claude-code': { ANTHROPIC_API_KEY: 'sk-claude-fixture-5678', enabled: true },
			},
		});

		const snapshot = readSettingsSnapshotFromFiles(paths());
		expect(snapshot.defaults).toEqual({
			shell: 'bash',
			saveToHistory: false,
			thinkingMode: 'off',
			envVars: [
				{ key: 'EDITOR', value: 'vim' },
				{ key: 'GROK_AUTH', value: '••••••••' },
			],
		});
		expect(snapshot.providers).toEqual([
			{
				providerId: 'claude-code',
				entries: [
					{ key: 'ANTHROPIC_API_KEY', value: '••••••••5678' },
					{ key: 'enabled', value: 'true' },
				],
			},
			{
				providerId: 'codex',
				entries: [
					{
						key: 'customEnvVars',
						value: 'OPENAI_API_KEY=••••••••1234, OPENAI_BASE_URL=https://api.example/v1',
					},
					{ key: 'model', value: 'fixture-model' },
				],
			},
			{
				providerId: 'grok',
				entries: [{ key: 'customEnvVars', value: 'GROK_XAI_API_BASE_URL=••••••••, MODE=fixture' }],
			},
		]);
		expect(snapshot.source).toBe('files');
		expect(snapshot.conductorProfile).toBe('Be brief.');
		expect(snapshot.problems).toEqual([]);
		const serialized = JSON.stringify(snapshot);
		for (const secret of ['file-only-secret', 'sk-codex-fixture', 'sk-claude-fixture']) {
			expect(serialized).not.toContain(secret);
		}
	});

	it('reads the settings, agent configs, and prompt customizations from disk', () => {
		write('maestro-settings.json', {
			defaultShell: 'bash',
			conductorProfile: 'Be brief.',
			encoreFeatures: { maestroCue: false },
			sshRemotes: [REMOTE],
		});
		write('maestro-agent-configs.json', { configs: { codex: { model: 'gpt-5' } } });
		write(PROMPT_CUSTOMIZATIONS_FILE, { prompts: { 'auto-run': { isModified: true } } });

		const snapshot = readSettingsSnapshotFromFiles(paths());
		expect(snapshot.source).toBe('files');
		expect(snapshot.defaults.shell).toBe('bash');
		expect(snapshot.encore.maestroCue).toBe(false);
		expect(snapshot.sshRemotes).toHaveLength(1);
		expect(snapshot.providers).toEqual([
			{ providerId: 'codex', entries: [{ key: 'model', value: 'gpt-5' }] },
		]);
		expect(snapshot.prompts).toEqual([{ id: 'auto-run', modified: true }]);
		expect(snapshot.problems).toEqual([]);
	});

	it('treats missing files as an unconfigured install and keeps going past a corrupt one', () => {
		expect(readSettingsSnapshotFromFiles(paths()).problems).toEqual([]);

		write('maestro-settings.json', '{ not json');
		write('maestro-agent-configs.json', { configs: { codex: { model: 'gpt-5' } } });
		write(PROMPT_CUSTOMIZATIONS_FILE, '[[');
		const snapshot = readSettingsSnapshotFromFiles(paths());
		expect(snapshot.providers).toHaveLength(1);
		expect(snapshot.encore).toEqual(ENCORE_FEATURE_DEFAULTS);
		expect(snapshot.problems.join('\n')).toMatch(/Settings file is corrupt/);
		expect(snapshot.problems.join('\n')).toMatch(/Prompt customizations are corrupt/);
	});
});

describe('loadSettingsSnapshot', () => {
	const clientOf = (
		state: string,
		settings: (keys: readonly string[]) => Promise<unknown>,
		remotes: () => Promise<unknown> = async () => ({ ok: true, value: [] })
	) =>
		({
			connection: { state: () => state },
			settings: { get: settings, sshRemotes: remotes, subscribe: () => () => undefined },
		}) as unknown as MaestroClient;

	it('reads the values the host holds, and the SSH remotes it serves', async () => {
		write('maestro-settings.json', { encoreFeatures: { maestroCue: true } });
		const asked: unknown[] = [];
		const client = clientOf(
			'connected',
			async (keys) => {
				asked.push(keys);
				return { ok: true, value: { encoreFeatures: { maestroCue: false } } };
			},
			async () => ({ ok: true, value: [REMOTE] })
		);
		const snapshot = await loadSettingsSnapshot(paths(), client);
		expect(snapshot.source).toBe('host');
		// The host's answer wins over the file.
		expect(snapshot.encore.maestroCue).toBe(false);
		expect(snapshot.sshRemotes).toHaveLength(1);
		expect(asked[0]).toContain('encoreFeatures');
	});

	it('falls back to the files, and says why, when the host refuses', async () => {
		write('maestro-settings.json', { encoreFeatures: { maestroCue: false } });
		const client = clientOf('connected', async () => ({
			ok: false,
			error: { code: 'failed', message: 'host is busy', method: 'settings.get' },
		}));
		const snapshot = await loadSettingsSnapshot(paths(), client);
		expect(snapshot.source).toBe('files');
		expect(snapshot.note).toContain('host is busy');
		expect(snapshot.encore.maestroCue).toBe(false);
	});

	it('does not ask a client that is not attached', async () => {
		let asked = false;
		const client = clientOf('reconnecting', async () => {
			asked = true;
			return { ok: true, value: {} };
		});
		const snapshot = await loadSettingsSnapshot(paths(), client);
		expect(asked).toBe(false);
		expect(snapshot.source).toBe('files');
		expect((await loadSettingsSnapshot(paths())).source).toBe('files');
	});
});
