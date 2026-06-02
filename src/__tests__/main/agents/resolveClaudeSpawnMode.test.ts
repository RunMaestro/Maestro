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
	it('runs maestro-p via execPath, prepends its flags, preserves the prompt args, and injects MAESTRO_CLAUDE_BIN', () => {
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
		expect(result.customEnvVars).toEqual({ FOO: 'bar', MAESTRO_CLAUDE_BIN: '/bin/claude' });
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
