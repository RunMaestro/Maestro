import { describe, it, expect } from 'vitest';
import {
	parseCodexAppServerInvocation,
	codexAppServerConfigBlocker,
	codexThreadPolicyMismatch,
	wantsCodexAppServer,
} from '../../../main/codex-app-server/invocation';
import type { CodexAppServerSshLaunch } from '../../../main/codex-app-server/ssh-launch';
import type { ProcessConfig } from '../../../main/process-manager/types';

function config(args: string[], overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: 's',
		toolType: 'codex',
		cwd: '/spawn/cwd',
		command: 'codex',
		args,
		prompt: 'hi',
		...overrides,
	};
}

const EXEC = ['exec', '--json', '--skip-git-repo-check'];

describe('parseCodexAppServerInvocation', () => {
	it('maps the default bypass invocation to danger-full-access', () => {
		const result = parseCodexAppServerInvocation(
			config(['-C', '/proj', ...EXEC, '--dangerously-bypass-approvals-and-sandbox'])
		);
		expect(result).toEqual({
			ok: true,
			invocation: { cwd: '/proj', sandbox: 'danger-full-access', configArgs: [] },
		});
	});

	it('maps read-only, model, overrides and resume', () => {
		const result = parseCodexAppServerInvocation(
			config([
				...EXEC,
				'--sandbox',
				'read-only',
				'-m',
				'gpt-5.3-codex',
				'-c',
				'model_reasoning_effort="xhigh"',
				'-c',
				"model_reasoning_summary='detailed'",
				'--config=foo.bar=1',
				'resume',
				'thread-123',
			])
		);
		expect(result).toEqual({
			ok: true,
			invocation: {
				cwd: '/spawn/cwd',
				sandbox: 'read-only',
				model: 'gpt-5.3-codex',
				effort: 'xhigh',
				summary: 'detailed',
				resumeId: 'thread-123',
				configArgs: [
					'-c',
					'model_reasoning_effort="xhigh"',
					'-c',
					"model_reasoning_summary='detailed'",
					'-c',
					'foo.bar=1',
				],
			},
		});
	});

	it('lets the bypass flag win over --sandbox, as exec does', () => {
		const result = parseCodexAppServerInvocation(
			config([...EXEC, '--sandbox', 'read-only', '--dangerously-bypass-approvals-and-sandbox'])
		);
		expect(result.ok && result.invocation.sandbox).toBe('danger-full-access');
	});

	it('leaves the sandbox to config.toml when the args name none', () => {
		const result = parseCodexAppServerInvocation(config(EXEC));
		expect(result.ok && result.invocation.sandbox).toBeUndefined();
	});

	it('never resumes from agentSessionId alone', () => {
		const result = parseCodexAppServerInvocation(config(EXEC, { agentSessionId: 'old-thread' }));
		expect(result.ok && result.invocation.resumeId).toBeUndefined();
	});

	it('carries --add-dir under full access, where it grants nothing more', () => {
		const result = parseCodexAppServerInvocation(
			config([
				...EXEC,
				'--dangerously-bypass-approvals-and-sandbox',
				'--add-dir',
				'/other',
				'--add-dir=/more',
				'resume',
				'thread-1',
			])
		);
		expect(result).toEqual({
			ok: true,
			invocation: {
				cwd: '/spawn/cwd',
				sandbox: 'danger-full-access',
				resumeId: 'thread-1',
				configArgs: [],
			},
		});
	});

	it.each([
		[['--add-dir', '/other'], 'write grant (--add-dir) outside full access'],
		[
			['--sandbox', 'workspace-write', '--add-dir', '/other'],
			'write grant (--add-dir) outside full access',
		],
		[
			['--sandbox', 'read-only', '--add-dir', '/other'],
			'write grant (--add-dir) outside full access',
		],
		[['--add-dir'], 'unsupported argument: --add-dir'],
		[['-i', '/tmp/a.png'], 'unsupported argument: -i'],
		[['--', 'prompt'], 'unsupported argument: --'],
		[['--sandbox', 'bogus'], 'unknown sandbox mode: bogus'],
		[['resume'], 'resume without a thread id'],
		[['-c', 'novalue'], 'malformed config override: novalue'],
	])('refuses %j', (extra, reason) => {
		expect(parseCodexAppServerInvocation(config([...EXEC, ...extra]))).toEqual({
			ok: false,
			reason,
		});
	});

	it('refuses an invocation that is not codex exec', () => {
		expect(parseCodexAppServerInvocation(config(['--json']))).toEqual({
			ok: false,
			reason: 'not an exec invocation',
		});
	});
});

describe('codexAppServerConfigBlocker', () => {
	it.each([
		[{ prompt: undefined }, 'no prompt'],
		[{ images: ['data:x'] }, 'image prompt'],
		[{ sshRemoteId: 'remote-1' }, 'SSH remote without an app-server launch'],
		[{ sshStdinScript: 'exec codex exec' }, 'SSH remote without an app-server launch'],
		[{ promptAlreadyInArgs: true }, 'prompt embedded in args'],
	] as Array<[Partial<ProcessConfig>, string]>)('blocks %j', (overrides, reason) => {
		expect(codexAppServerConfigBlocker(config(EXEC, overrides))).toBe(reason);
	});

	it('allows a plain local text turn', () => {
		expect(codexAppServerConfigBlocker(config(EXEC))).toBeNull();
	});
});

describe('an SSH turn with an app-server launch', () => {
	/** An SSH config as the spawn handler hands it over: ssh args, the local cwd, no prompt. */
	const sshConfig = (launch: Partial<CodexAppServerSshLaunch> = {}) =>
		config(['-o', 'BatchMode=yes', 'host', '/bin/bash', '--norc', '--noprofile', '-s'], {
			cwd: '/Users/me',
			prompt: undefined,
			sshRemoteId: 'remote-1',
			sshStdinScript: 'exec codex exec --json',
			codexAppServerSsh: {
				command: 'ssh',
				args: ['host', '/bin/bash', '--norc', '--noprofile', '-s'],
				stdinScript: 'exec codex app-server\n',
				remoteCommandLine: 'codex app-server',
				execArgs: [...EXEC, '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-x'],
				cwd: '/home/me/proj',
				prompt: 'fix the bug',
				...launch,
			},
		});

	it('is carried, read from the planned exec turn and the remote cwd', () => {
		expect(codexAppServerConfigBlocker(sshConfig())).toBeNull();
		expect(parseCodexAppServerInvocation(sshConfig())).toEqual({
			ok: true,
			invocation: {
				cwd: '/home/me/proj',
				sandbox: 'danger-full-access',
				model: 'gpt-x',
				configArgs: [],
			},
		});
	});

	it('still needs a prompt and an exec arg list app-server can carry', () => {
		expect(codexAppServerConfigBlocker(sshConfig({ prompt: '' }))).toBe('no prompt');
		expect(parseCodexAppServerInvocation(sshConfig({ execArgs: [...EXEC, '--oss'] }))).toEqual({
			ok: false,
			reason: 'unsupported argument: --oss',
		});
	});
});

describe('wantsCodexAppServer', () => {
	it('is true only for an opted-in Codex agent on a turn a person sent', () => {
		const want = (overrides: Partial<ProcessConfig>) =>
			wantsCodexAppServer({ toolType: 'codex', codexTransport: 'app-server', ...overrides });
		expect(want({})).toBe(true);
		expect(want({ querySource: 'user' })).toBe(true);
		expect(want({ querySource: 'auto' })).toBe(false);
		expect(want({ querySource: 'cue' })).toBe(false);
		expect(want({ codexTransport: 'exec' })).toBe(false);
		expect(want({ toolType: 'claude-code' })).toBe(false);
	});
});

describe('codexThreadPolicyMismatch', () => {
	const echo = (sandbox: unknown, approvalPolicy: unknown = 'never') => ({
		thread: { id: 't' },
		sandbox,
		approvalPolicy,
	});

	it('accepts the sandbox the server echoes for each restricted mode', () => {
		expect(
			codexThreadPolicyMismatch({ sandbox: 'read-only' }, echo({ type: 'readOnly' }))
		).toBeNull();
		expect(
			codexThreadPolicyMismatch(
				{ sandbox: 'workspace-write' },
				echo({ type: 'workspaceWrite', writableRoots: [] })
			)
		).toBeNull();
	});

	it('flags a resumed thread that kept a wider persisted sandbox', () => {
		expect(
			codexThreadPolicyMismatch({ sandbox: 'read-only' }, echo({ type: 'dangerFullAccess' }))
		).toMatch(/read-only.*dangerFullAccess/);
		expect(
			codexThreadPolicyMismatch({ sandbox: 'workspace-write' }, echo({ type: 'readOnly' }))
		).toMatch(/workspace-write/);
	});

	it('flags a response that does not say which sandbox the thread runs in', () => {
		expect(codexThreadPolicyMismatch({ sandbox: 'read-only' }, { thread: { id: 't' } })).toMatch(
			/unreported/
		);
		expect(codexThreadPolicyMismatch({ sandbox: 'read-only' }, null)).toMatch(/unreported/);
	});

	it('does not check full access or a sandbox left to config.toml', () => {
		expect(codexThreadPolicyMismatch({ sandbox: 'danger-full-access' }, {})).toBeNull();
		expect(codexThreadPolicyMismatch({}, {})).toBeNull();
	});

	it('does not check the approval policy, which cannot widen a restricted turn', () => {
		expect(
			codexThreadPolicyMismatch({ sandbox: 'read-only' }, echo({ type: 'readOnly' }, 'on-request'))
		).toBeNull();
	});
});
