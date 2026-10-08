/**
 * Tests for the shared Cue run router (`cue-run-router.ts`): one path from a
 * fired subscription to its executor, used by both the desktop app and the
 * standalone runner. Every executor is a mock passed through the deps, which
 * is also how production wires them.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	executeCueRunAction,
	type CueRunActionDeps,
	type CueRunSessionRecord,
	type OnCueRunParams,
} from '../../../main/cue/cue-run-router';
import type { CueRunResult } from '../../../shared/cue/contracts';

const SESSION: CueRunSessionRecord = {
	id: 'agent-1',
	name: 'Builder',
	toolType: 'claude-code',
	cwd: '/work/cwd',
	projectRoot: '/work/project',
	fullPath: '/work/full',
	autoRunFolderPath: '/work/project/autorun',
	sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-7' },
	customModel: 'opus',
};

function fakeResult(runId: string): CueRunResult {
	return { runId, subscriptionName: 'sub', status: 'completed' } as unknown as CueRunResult;
}

function makeDeps(overrides: Partial<CueRunActionDeps> = {}) {
	const deps = {
		executeCuePrompt: vi.fn(async (c: { runId: string }) => fakeResult(c.runId)),
		executeCueShell: vi.fn(async (c: { runId: string }) => fakeResult(c.runId)),
		executeCueCli: vi.fn(async (c: { runId: string }) => fakeResult(c.runId)),
		stopCueRun: vi.fn(() => true),
		findSession: vi.fn((id: string) => (id === SESSION.id ? SESSION : undefined)),
		resolveAgentPath: vi.fn(async () => '/detected/claude'),
		sshStore: { getSshRemotes: () => [] },
		getAgentConfigValues: vi.fn(() => ({}) as Record<string, unknown>),
		onLog: vi.fn(),
		getConductorProfile: vi.fn(() => 'I am the conductor'),
		onNotify: vi.fn(async (p: { runId: string }) => fakeResult(p.runId)),
		reportAuthFailure: vi.fn(async () => {}),
		...overrides,
	};
	return deps as unknown as CueRunActionDeps & typeof deps;
}

function params(overrides: Partial<OnCueRunParams> = {}): OnCueRunParams {
	return {
		runId: 'run-1',
		sessionId: SESSION.id,
		prompt: 'do the thing',
		subscriptionName: 'nightly',
		event: { type: 'time.heartbeat' } as OnCueRunParams['event'],
		timeoutMs: 60_000,
		...overrides,
	};
}

describe('executeCueRunAction', () => {
	it('throws when the target session is gone', async () => {
		const deps = makeDeps();
		await expect(executeCueRunAction(deps, params({ sessionId: 'missing' }))).rejects.toThrow(
			'Cue target session not found: missing'
		);
	});

	it('routes notify through onNotify with agent_id and the resolved message', async () => {
		const deps = makeDeps();
		await executeCueRunAction(
			deps,
			params({ action: 'notify', notify: { message: '  heads up  ', sticky: true } as never })
		);

		expect(deps.onNotify).toHaveBeenCalledTimes(1);
		const call = deps.onNotify.mock.calls[0][0] as Record<string, any>;
		expect(call.subscription.agent_id).toBe(SESSION.id);
		expect(call.agentId).toBe(SESSION.id);
		expect(call.message).toBe('heads up');
		expect(call.sticky).toBe(true);
		expect(call.title).toBe('Builder');
		expect(call.session.cwd).toBe('/work/project');
		expect(deps.executeCuePrompt).not.toHaveBeenCalled();
	});

	it('falls back to the prompt when notify carries no message', async () => {
		const deps = makeDeps();
		await executeCueRunAction(deps, params({ action: 'notify' }));
		expect((deps.onNotify.mock.calls[0][0] as Record<string, any>).message).toBe('do the thing');
	});

	it('runs a shell command with SSH config and the template context', async () => {
		const deps = makeDeps();
		await executeCueRunAction(
			deps,
			params({ action: 'command', command: { mode: 'shell', shell: 'echo hi' } as never })
		);

		expect(deps.executeCueShell).toHaveBeenCalledTimes(1);
		const call = deps.executeCueShell.mock.calls[0][0] as Record<string, any>;
		expect(call.shellCommand).toBe('echo hi');
		expect(call.projectRoot).toBe('/work/project');
		expect(call.sshRemoteConfig).toEqual(SESSION.sessionSshRemoteConfig);
		expect(call.sshStore).toBe(deps.sshStore);
		expect(call.templateContext.conductorProfile).toBe('I am the conductor');
		expect(deps.executeCueCli).not.toHaveBeenCalled();
	});

	it('runs a maestro-cli command locally, without SSH config', async () => {
		const deps = makeDeps();
		const cli = { command: 'send', target: 'agent-2' };
		await executeCueRunAction(
			deps,
			params({ action: 'command', command: { mode: 'cli', cli } as never })
		);

		expect(deps.executeCueCli).toHaveBeenCalledTimes(1);
		const call = deps.executeCueCli.mock.calls[0][0] as Record<string, any>;
		expect(call.cli).toBe(cli);
		expect(call).not.toHaveProperty('sshRemoteConfig');
		expect(deps.executeCueShell).not.toHaveBeenCalled();
	});

	it('refuses a command action with no command payload', async () => {
		const deps = makeDeps();
		await expect(executeCueRunAction(deps, params({ action: 'command' }))).rejects.toThrow(
			`has action='command' but no command payload`
		);
	});

	it('runs a prompt with the agent overrides and reports auth failures with the remote id', async () => {
		const deps = makeDeps();
		const result = await executeCueRunAction(deps, params());

		expect(result.runId).toBe('run-1');
		const call = deps.executeCuePrompt.mock.calls[0][0] as Record<string, any>;
		expect(call.promptPath).toBe('do the thing');
		expect(call.toolType).toBe('claude-code');
		expect(call.customPath).toBe('/detected/claude');
		expect(call.customModel).toBe('opus');
		expect(call.templateContext.session.fullPath).toBe('/work/full');
		expect(deps.reportAuthFailure).toHaveBeenCalledWith(result, 'claude-code', 'remote-7');
	});

	it('prefers the configured customPath over the detector', async () => {
		const deps = makeDeps({
			getAgentConfigValues: vi.fn(() => ({ customPath: '/custom/claude' })),
		});
		await executeCueRunAction(deps, params());
		expect((deps.executeCuePrompt.mock.calls[0][0] as Record<string, any>).customPath).toBe(
			'/custom/claude'
		);
		expect(deps.resolveAgentPath).not.toHaveBeenCalled();
	});

	it('omits the remote id from the auth report while SSH is disabled', async () => {
		const deps = makeDeps({
			findSession: vi.fn(() => ({
				...SESSION,
				sessionSshRemoteConfig: { enabled: false, remoteId: 'remote-7' },
			})),
		});
		const result = await executeCueRunAction(deps, params());
		expect(deps.reportAuthFailure).toHaveBeenCalledWith(result, 'claude-code', undefined);
	});

	it('threads isServerMode into prompt and shell runs', async () => {
		const deps = makeDeps({ isServerMode: true });
		await executeCueRunAction(deps, params());
		await executeCueRunAction(
			deps,
			params({ action: 'command', command: { mode: 'shell', shell: 'env' } as never })
		);
		expect((deps.executeCuePrompt.mock.calls[0][0] as Record<string, any>).isServerMode).toBe(true);
		expect((deps.executeCueShell.mock.calls[0][0] as Record<string, any>).isServerMode).toBe(true);
	});

	it('reads the conductor profile on every run rather than once', async () => {
		let profile = 'first';
		const deps = makeDeps({ getConductorProfile: vi.fn(() => profile) });

		await executeCueRunAction(deps, params({ runId: 'a' }));
		profile = 'second';
		await executeCueRunAction(deps, params({ runId: 'b' }));

		expect(deps.getConductorProfile).toHaveBeenCalledTimes(2);
		const [first, second] = deps.executeCuePrompt.mock.calls.map(
			(c) => (c[0] as Record<string, any>).templateContext.conductorProfile
		);
		expect(first).toBe('first');
		expect(second).toBe('second');
	});
});

describe('executeCueRunAction with a stopped run', () => {
	it.each([
		['prompt', {}],
		['shell command', { action: 'command', command: { mode: 'shell', shell: 'echo hi' } }],
		[
			'maestro-cli command',
			{ action: 'command', command: { mode: 'cli', cli: { command: 'send', target: 'x' } } },
		],
		['notify', { action: 'notify' }],
	] as const)(
		'hands no %s run to an executor once the signal is aborted',
		async (_label, extra) => {
			const deps = makeDeps();
			const controller = new AbortController();
			controller.abort();
			const result = await executeCueRunAction(
				deps,
				params({ ...(extra as Partial<OnCueRunParams>), signal: controller.signal })
			);
			expect(result).toMatchObject({ runId: 'run-1', status: 'stopped', sessionName: 'Builder' });
			expect(deps.executeCuePrompt).not.toHaveBeenCalled();
			expect(deps.executeCueShell).not.toHaveBeenCalled();
			expect(deps.executeCueCli).not.toHaveBeenCalled();
			expect(deps.onNotify).not.toHaveBeenCalled();
		}
	);

	it('stops a prompt run whose agent path probe was still pending', async () => {
		let finishProbe!: (path: string) => void;
		const deps = makeDeps({
			resolveAgentPath: vi.fn(
				() =>
					new Promise<string>((resolve) => {
						finishProbe = resolve;
					})
			),
		});
		const controller = new AbortController();
		const pending = executeCueRunAction(deps, params({ signal: controller.signal }));
		await vi.waitFor(() => expect(finishProbe).toBeTypeOf('function'));
		controller.abort();
		finishProbe('/detected/claude');
		expect((await pending).status).toBe('stopped');
		expect(deps.executeCuePrompt).not.toHaveBeenCalled();
	});

	it('passes the signal on to every executor', async () => {
		const deps = makeDeps();
		const { signal } = new AbortController();
		await executeCueRunAction(deps, params({ signal }));
		await executeCueRunAction(
			deps,
			params({ signal, action: 'command', command: { mode: 'shell', shell: 'echo hi' } })
		);
		await executeCueRunAction(
			deps,
			params({
				signal,
				action: 'command',
				command: { mode: 'cli', cli: { command: 'send', target: 'x' } },
			})
		);
		expect(deps.executeCuePrompt).toHaveBeenCalledWith(expect.objectContaining({ signal }));
		expect(deps.executeCueShell).toHaveBeenCalledWith(expect.objectContaining({ signal }));
		expect(deps.executeCueCli).toHaveBeenCalledWith(expect.objectContaining({ signal }));
	});
});
