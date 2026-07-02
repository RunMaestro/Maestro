import { describe, it, expect } from 'vitest';
import {
	resolveClaudeSpawnMode,
	applyClaudeSpawnDecision,
	buildRemoteInteractiveSpawn,
	REMOTE_MAESTRO_P_COMMAND,
	type ResolveClaudeSpawnModeDeps,
} from '../../../main/agents/resolveClaudeSpawnMode';
import { asarNodePath } from '../../helpers/pathExpect';
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
		// Default to "unknown" so remote interactive stays optimistic unless a test
		// pins a probe result.
		getRemoteMaestroPAvailable: () => undefined,
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

	it('SSH-enabled claude with api token mode stays on API', () => {
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'api',
			sshEnabled: true,
			command: 'claude',
			now: NOW,
			deps: makeDeps(),
		});
		expect(r.mode).toBe('api');
		expect(r.remote).toBeFalsy();
	});

	it('SSH-enabled claude with interactive token mode resolves to remote interactive', () => {
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'interactive',
			sshEnabled: true,
			command: 'claude',
			now: NOW,
			deps: makeDeps(),
		});
		expect(r.mode).toBe('interactive');
		expect(r.remote).toBe(true);
		// No LOCAL maestro-p script is used for remote spawns; maestro-p runs on
		// the remote host.
		expect(r.maestroPBinPath).toBeNull();
	});

	it('SSH-enabled claude with dynamic token mode falls back to API (no remote quota signal)', () => {
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'dynamic',
			sshEnabled: true,
			command: 'claude',
			// Dynamic is not a valid remote choice (the selector hides it); the
			// local snapshot says nothing about the remote account, so dynamic must
			// NOT silently drive the remote TUI / spend Max quota - it resolves api.
			deps: makeDeps({ getUsageSnapshot: () => healthySnapshot() }),
			now: NOW,
		});
		expect(r.mode).toBe('api');
		expect(r.remote).toBeFalsy();
	});

	it('SSH-enabled interactive falls back to API when the remote has no maestro-p (known-absent)', () => {
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'interactive',
			sshEnabled: true,
			sshRemoteId: 'remote-1',
			command: 'claude',
			now: NOW,
			// Probe determined maestro-p is NOT on the remote PATH: spawning it would
			// exit 127 on every turn, so the resolver must fall back to API.
			deps: makeDeps({ getRemoteMaestroPAvailable: () => false }),
		});
		expect(r.mode).toBe('api');
		expect(r.remote).toBeFalsy();
		expect(r.maestroPBinPath).toBeNull();
	});

	it('SSH-enabled interactive stays remote when the remote has maestro-p (known-present)', () => {
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'interactive',
			sshEnabled: true,
			sshRemoteId: 'remote-1',
			command: 'claude',
			now: NOW,
			deps: makeDeps({ getRemoteMaestroPAvailable: () => true }),
		});
		expect(r.mode).toBe('interactive');
		expect(r.remote).toBe(true);
	});

	it('SSH-enabled interactive stays remote when remote maestro-p availability is unknown (optimistic)', () => {
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'interactive',
			sshEnabled: true,
			sshRemoteId: 'remote-1',
			command: 'claude',
			now: NOW,
			deps: makeDeps({ getRemoteMaestroPAvailable: () => undefined }),
		});
		expect(r.mode).toBe('interactive');
		expect(r.remote).toBe(true);
	});

	it('SSH-enabled remote interactive carries a custom remote claude path as the real bin', () => {
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'interactive',
			sshEnabled: true,
			command: 'claude',
			sessionCustomPath: '/remote/bin/claude',
			now: NOW,
			deps: makeDeps(),
		});
		expect(r.remote).toBe(true);
		expect(r.claudeRealBinPath).toBe('/remote/bin/claude');
	});

	it('SSH remote interactive does NOT forward a maestro-p custom path as the real bin (self-spawn guard)', () => {
		// Regression: when the agent's binary IS maestro-p, forwarding it as
		// MAESTRO_CLAUDE_BIN makes the remote maestro-p drive itself in the PTY -
		// the claude child exits instantly and the turn dies as `tui_exited`.
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'interactive',
			sshEnabled: true,
			command: 'claude',
			sessionCustomPath: '/usr/local/bin/maestro-p',
			now: NOW,
			deps: makeDeps(),
		});
		expect(r.remote).toBe(true);
		// Undefined → remote maestro-p defaults to `claude` on its PATH.
		expect(r.claudeRealBinPath).toBeUndefined();
	});

	it('local interactive does NOT use a maestro-p custom path as the real bin (self-spawn guard)', () => {
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'interactive',
			sshEnabled: false,
			command: 'claude',
			sessionCustomPath: '/custom/maestro-p',
			now: NOW,
			deps: makeDeps(),
		});
		expect(r.mode).toBe('interactive');
		// Falls back to the resolved command (real claude), not the maestro-p path.
		expect(r.claudeRealBinPath).toBe('claude');
	});

	it('local interactive with maestro-p as BOTH command and custom path leaves the real bin unset', () => {
		const r = resolveClaudeSpawnMode({
			agent: claudeAgent,
			tokenMode: 'interactive',
			sshEnabled: false,
			command: '/custom/maestro-p',
			sessionCustomPath: '/custom/maestro-p',
			now: NOW,
			deps: makeDeps(),
		});
		expect(r.mode).toBe('interactive');
		// Both are maestro-p → undefined so maestro-p defaults to `claude` on PATH.
		expect(r.claudeRealBinPath).toBeUndefined();
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

	it('injects --max-wait (rounded up) before the maestro-p flags when maxWaitSeconds is given', () => {
		const result = applyClaudeSpawnDecision({
			decision: {
				mode: 'interactive',
				reason: 'auto',
				maestroPBinPath: '/bundled/maestro-p.js',
				claudeRealBinPath: '/bin/claude',
			},
			interactiveModeArgs: ['--dangerously-skip-permissions'],
			command: 'claude',
			args: ['--print', '--', 'hello there'],
			execPath: '/usr/bin/node',
			maxWaitSeconds: 3599.4,
		});
		// --max-wait must land AFTER the script but BEFORE the batch args, which
		// terminate with `-- <prompt>` (anything after `--` is read as the prompt
		// positional, not a flag). Value is ceil()'d to a whole second.
		expect(result.args).toEqual([
			'/bundled/maestro-p.js',
			'--max-wait',
			'3600',
			'--dangerously-skip-permissions',
			'--print',
			'--',
			'hello there',
		]);
	});

	it('omits --max-wait when maxWaitSeconds is absent or non-positive', () => {
		const base = {
			decision: {
				mode: 'interactive' as const,
				reason: 'auto' as const,
				maestroPBinPath: '/bundled/maestro-p.js',
				claudeRealBinPath: '/bin/claude',
			},
			interactiveModeArgs: [],
			command: 'claude',
			args: ['--print', '--', 'hi'],
			execPath: '/usr/bin/node',
		};
		expect(applyClaudeSpawnDecision(base).args).toEqual([
			'/bundled/maestro-p.js',
			'--print',
			'--',
			'hi',
		]);
		expect(applyClaudeSpawnDecision({ ...base, maxWaitSeconds: 0 }).args).toEqual([
			'/bundled/maestro-p.js',
			'--print',
			'--',
			'hi',
		]);
	});

	it('adds NODE_PATH to the unpacked modules dir when running packaged (resourcesPath set)', () => {
		const original = process.resourcesPath;
		// The source prepends the asar path to any EXISTING NODE_PATH, so this
		// assertion is only deterministic on a clean slate. A developer's shell may
		// export NODE_PATH (e.g. pointing at a packaged Maestro), which would
		// otherwise leak in and double the value - isolate it for the duration.
		const originalNodePath = process.env.NODE_PATH;
		delete process.env.NODE_PATH;
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
				asarNodePath('/Applications/Maestro.app/Contents/Resources')
			);
		} finally {
			Object.defineProperty(process, 'resourcesPath', {
				value: original,
				configurable: true,
			});
			if (originalNodePath === undefined) {
				delete process.env.NODE_PATH;
			} else {
				process.env.NODE_PATH = originalNodePath;
			}
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

describe('buildRemoteInteractiveSpawn (SSH remote surfaces)', () => {
	it('returns null for an API decision (leave SSH config untouched)', () => {
		const result = buildRemoteInteractiveSpawn({
			decision: { mode: 'api', reason: 'auto', maestroPBinPath: null },
			interactiveModeArgs: ['--dangerously-skip-permissions'],
		});
		expect(result).toBeNull();
	});

	it('returns null for a LOCAL interactive decision (not remote)', () => {
		const result = buildRemoteInteractiveSpawn({
			decision: {
				mode: 'interactive',
				reason: 'auto',
				maestroPBinPath: '/bundled/maestro-p.js',
			},
			interactiveModeArgs: ['--dangerously-skip-permissions'],
		});
		expect(result).toBeNull();
	});

	it('swaps the command to maestro-p and prepends the interactive flags for a remote decision', () => {
		const result = buildRemoteInteractiveSpawn({
			decision: { mode: 'interactive', reason: 'auto', maestroPBinPath: null, remote: true },
			interactiveModeArgs: ['--dangerously-skip-permissions'],
		});
		expect(result).not.toBeNull();
		expect(result!.command).toBe(REMOTE_MAESTRO_P_COMMAND);
		expect(result!.prependArgs).toEqual(['--dangerously-skip-permissions']);
		// No MAESTRO_CLAUDE_BIN when no custom remote claude path: maestro-p
		// defaults to `claude` on the remote PATH.
		expect(result!.env).toEqual({});
	});

	it('points MAESTRO_CLAUDE_BIN at a custom remote claude path when provided', () => {
		const result = buildRemoteInteractiveSpawn({
			decision: {
				mode: 'interactive',
				reason: 'auto',
				maestroPBinPath: null,
				remote: true,
				claudeRealBinPath: '/remote/bin/claude',
			},
			interactiveModeArgs: ['--dangerously-skip-permissions'],
			remoteClaudeBin: '/remote/bin/claude',
		});
		expect(result!.env).toEqual({ MAESTRO_CLAUDE_BIN: '/remote/bin/claude' });
	});

	it('injects --max-wait ahead of the interactive flags for background surfaces', () => {
		const result = buildRemoteInteractiveSpawn({
			decision: { mode: 'interactive', reason: 'auto', maestroPBinPath: null, remote: true },
			interactiveModeArgs: ['--dangerously-skip-permissions'],
			maxWaitSeconds: 600,
		});
		expect(result!.prependArgs).toEqual(['--max-wait', '600', '--dangerously-skip-permissions']);
	});

	it('omits --max-wait when no positive budget is given', () => {
		const result = buildRemoteInteractiveSpawn({
			decision: { mode: 'interactive', reason: 'auto', maestroPBinPath: null, remote: true },
			interactiveModeArgs: ['--dangerously-skip-permissions'],
			maxWaitSeconds: 0,
		});
		expect(result!.prependArgs).toEqual(['--dangerously-skip-permissions']);
	});
});
