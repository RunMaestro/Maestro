import { describe, it, expect } from 'vitest';
import {
	resolveClaudeSpawnMode,
	applyClaudeSpawnDecision,
	type ResolveClaudeSpawnModeDeps,
} from '../../../main/agents/resolveClaudeSpawnMode';
import type { UsageSnapshot } from '../../../main/agents/claude-mode-selector';

const claudeAgent = {
	id: 'claude-code',
	interactiveCommand: 'maestro-p',
	interactiveModeArgs: ['--dangerously-skip-permissions'],
	defaultEnvVars: {},
};

const NOW = new Date('2026-06-02T12:00:00Z');

/** A snapshot whose windows are open (resets in the future) and under threshold. */
function healthySnapshot(): UsageSnapshot {
	const future = new Date('2026-06-02T18:00:00Z').toISOString();
	return {
		sampledAt: NOW.toISOString(),
		configDirKey: 'key',
		session: { percent: 10, resetsAt: future },
		weekAllModels: { percent: 10, resetsAt: future },
		weekSonnetOnly: { percent: 10, resetsAt: future },
	};
}

/** A snapshot whose 5-hour window is maxed out (still open). */
function limitedSnapshot(): UsageSnapshot {
	const future = new Date('2026-06-02T18:00:00Z').toISOString();
	return {
		sampledAt: NOW.toISOString(),
		configDirKey: 'key',
		session: { percent: 100, resetsAt: future },
		weekAllModels: { percent: 10, resetsAt: future },
		weekSonnetOnly: { percent: 10, resetsAt: future },
	};
}

function makeDeps(
	over: Partial<ResolveClaudeSpawnModeDeps> = {}
): Partial<ResolveClaudeSpawnModeDeps> {
	return {
		getMaestroPBinPath: () => '/bundled/maestro-p.js',
		isMaestroPBinaryPath: (p) => !!p && p.includes('maestro-p'),
		resolveConfigDirKey: () => 'key',
		getUsageSnapshot: () => healthySnapshot(),
		fileExists: () => true,
		...over,
	};
}

describe('resolveClaudeSpawnMode', () => {
	it('non-claude agents always resolve to API', () => {
		const r = resolveClaudeSpawnMode({
			agent: { id: 'codex', defaultEnvVars: {} } as never,
			tokenMode: 'dynamic',
			sshEnabled: false,
			command: 'codex',
			now: NOW,
			deps: makeDeps(),
		});
		expect(r.mode).toBe('api');
		expect(r.maestroPBinPath).toBeNull();
	});

	it('SSH-enabled claude spawns stay on API even when interactive is selected', () => {
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'interactive',
			sshEnabled: true,
			command: 'claude',
			now: NOW,
			deps: makeDeps(),
		});
		expect(r.mode).toBe('api');
	});

	it('api mode resolves to api', () => {
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'api',
			sshEnabled: false,
			command: 'claude',
			now: NOW,
			deps: makeDeps(),
		});
		expect(r.mode).toBe('api');
		expect(r.maestroPBinPath).toBeNull();
	});

	it('interactive mode always resolves to interactive regardless of usage', () => {
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'interactive',
			sshEnabled: false,
			command: '/bin/claude',
			now: NOW,
			deps: makeDeps({ getUsageSnapshot: () => limitedSnapshot() }),
		});
		expect(r.mode).toBe('interactive');
		expect(r.maestroPBinPath).toBe('/bundled/maestro-p.js');
		expect(r.claudeRealBinPath).toBe('/bin/claude');
	});

	it('dynamic mode picks interactive when under the usage threshold', () => {
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'dynamic',
			sshEnabled: false,
			command: 'claude',
			now: NOW,
			deps: makeDeps({ getUsageSnapshot: () => healthySnapshot() }),
		});
		expect(r.mode).toBe('interactive');
		expect(r.reason).toBe('auto');
	});

	it('dynamic mode falls back to api when a window is at the limit', () => {
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'dynamic',
			sshEnabled: false,
			command: 'claude',
			now: NOW,
			deps: makeDeps({ getUsageSnapshot: () => limitedSnapshot() }),
		});
		expect(r.mode).toBe('api');
		expect(r.reason).toBe('limit');
	});

	it('dynamic mode holds the api fallback stickily while a window stays open', () => {
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'dynamic',
			sshEnabled: false,
			command: 'claude',
			persisted: { mode: 'api', modeReason: 'limit' },
			now: NOW,
			deps: makeDeps({ getUsageSnapshot: () => healthySnapshot() }),
		});
		expect(r.mode).toBe('api');
		expect(r.reason).toBe('limit');
	});

	it('falls back to api when the maestro-p binary cannot be found', () => {
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'interactive',
			sshEnabled: false,
			command: 'claude',
			now: NOW,
			deps: makeDeps({ getMaestroPBinPath: () => null, fileExists: () => false }),
		});
		expect(r.mode).toBe('api');
		expect(r.maestroPBinPath).toBeNull();
	});

	it('detects a maestro-p binary wired directly into the Path under api mode', () => {
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'api',
			sshEnabled: false,
			command: '/custom/maestro-p',
			sessionCustomPath: '/custom/maestro-p',
			now: NOW,
			deps: makeDeps(),
		});
		expect(r.mode).toBe('interactive');
		expect(r.directBinary).toBe(true);
		expect(r.maestroPBinPath).toBeNull();
		expect(r.configDirKey).toBe('key');
	});

	it('surfaces a config-dir key in api mode when clearing a stale interactive state', () => {
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'api',
			sshEnabled: false,
			command: 'claude',
			persisted: { mode: 'interactive' },
			now: NOW,
			deps: makeDeps(),
		});
		expect(r.mode).toBe('api');
		expect(r.configDirKey).toBe('key');
	});
});

describe('applyClaudeSpawnDecision (batch surfaces)', () => {
	it('runs maestro-p via execPath, prepends its flags, preserves the prompt args, and injects MAESTRO_CLAUDE_BIN + ELECTRON_RUN_AS_NODE', () => {
		const result = applyClaudeSpawnDecision({
			decision: {
				mode: 'interactive',
				reason: 'auto',
				maestroPBinPath: '/bundled/maestro-p.js',
				claudeRealBinPath: '/bin/claude',
			},
			interactiveModeArgs: ['--dangerously-skip-permissions'],
			command: 'claude',
			args: ['--print', '--verbose', '--output-format', 'stream-json', '--', 'hello there'],
			customEnvVars: { FOO: 'bar' },
			execPath: '/usr/bin/node',
		});
		expect(result.command).toBe('/usr/bin/node');
		// maestro-p script + its flags prepended; the original args (incl. the
		// prompt after `--`) are forwarded verbatim for maestro-p to parse.
		expect(result.args).toEqual([
			'/bundled/maestro-p.js',
			'--dangerously-skip-permissions',
			'--print',
			'--verbose',
			'--output-format',
			'stream-json',
			'--',
			'hello there',
		]);
		// ELECTRON_RUN_AS_NODE=1 is mandatory: command is `process.execPath` (the
		// Electron binary in a packaged app), which would otherwise launch a GUI
		// instead of running maestro-p.js as Node. NODE_PATH is only added when
		// `process.resourcesPath` is set (packaged); in the test env it is not, so
		// it must be absent here.
		expect(result.customEnvVars).toEqual({
			FOO: 'bar',
			MAESTRO_CLAUDE_BIN: '/bin/claude',
			ELECTRON_RUN_AS_NODE: '1',
		});
	});

	it('adds NODE_PATH to the unpacked modules dir when running packaged (resourcesPath set)', () => {
		const original = process.resourcesPath;
		try {
			// Simulate a packaged app: resourcesPath points at the app Resources dir.
			Object.defineProperty(process, 'resourcesPath', {
				value: '/Applications/Maestro.app/Contents/Resources',
				configurable: true,
			});
			const result = applyClaudeSpawnDecision({
				decision: {
					mode: 'interactive',
					reason: 'auto',
					maestroPBinPath: '/res/maestro-p.js',
					claudeRealBinPath: '/bin/claude',
				},
				interactiveModeArgs: [],
				command: 'claude',
				args: ['--print', '--', 'hi'],
				execPath: '/Applications/Maestro.app/Contents/MacOS/Maestro',
			});
			expect(result.customEnvVars?.ELECTRON_RUN_AS_NODE).toBe('1');
			// NODE_PATH must point at the IN-ASAR node_modules, not the unpacked
			// copy: node-pty rewrites 'app.asar' -> 'app.asar.unpacked' for its
			// spawn-helper, so handing it the unpacked path double-applies and the
			// helper exec fails (posix_spawn ENOENT).
			expect(result.customEnvVars?.NODE_PATH).toBe(
				'/Applications/Maestro.app/Contents/Resources/app.asar/node_modules'
			);
		} finally {
			Object.defineProperty(process, 'resourcesPath', {
				value: original,
				configurable: true,
			});
		}
	});

	it('passes through unchanged for api mode', () => {
		const result = applyClaudeSpawnDecision({
			decision: { mode: 'api', reason: 'auto', maestroPBinPath: null },
			interactiveModeArgs: ['--dangerously-skip-permissions'],
			command: 'claude',
			args: ['--print', '--', 'hi'],
		});
		expect(result.command).toBe('claude');
		expect(result.args).toEqual(['--print', '--', 'hi']);
	});

	it('passes through unchanged for direct-binary interactive (no execPath wrap)', () => {
		const result = applyClaudeSpawnDecision({
			decision: {
				mode: 'interactive',
				reason: 'auto',
				maestroPBinPath: null,
				directBinary: true,
			},
			interactiveModeArgs: ['--dangerously-skip-permissions'],
			command: '/custom/maestro-p',
			args: ['--print', '--', 'hi'],
		});
		expect(result.command).toBe('/custom/maestro-p');
		expect(result.args).toEqual(['--print', '--', 'hi']);
	});
});
