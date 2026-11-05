import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worktreeRetirement } from '../../../main/git/worktreeRetirement';
import { acquireProviderSessionWriter } from '../../../main/utils/provider-session-writer';
import { createPluginHeadlessAgentRunner } from '../../../main/plugins/plugin-headless-agent-runner';
import type { PluginHeadlessRunnerDeps } from '../../../main/plugins/plugin-headless-agent-runner';
import type { SessionInfo } from '../../../shared/types';

vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

describe('Main headless worktree admission', () => {
	let fixture: string;
	let checkout: { path: string; head: string; generation: number };
	let agent: SessionInfo;
	let token: object | undefined;
	let deps: PluginHeadlessRunnerDeps;
	beforeEach(() => {
		fixture = mkdtempSync(join(process.cwd(), '.headless-admission-'));
		checkout = { path: join(fixture, 'checkout'), head: 'abc', generation: 1 };
		mkdirSync(checkout.path);
		expect(worktreeRetirement.register(checkout)).toBe(true);
		agent = { id: 'headless-fixture', toolType: 'codex', cwd: checkout.path } as SessionInfo;
		deps = {
			getAgent: () => agent,
			detectAgent: vi.fn(async () => ({ available: true })),
			hasPluginTools: () => false,
			spawn: vi.fn(async () => ({ success: true, response: 'done' })),
			prepareSystemPrompt: vi.fn(async () => undefined),
			issueRunToken: vi.fn(),
			revokeRunToken: vi.fn(),
			cliScriptPath: () => '/fixture-cli.js',
			audit: vi.fn(),
		};
	});
	afterEach(() => {
		if (token) worktreeRetirement.abort(token);
		token = undefined;
		rmSync(fixture, { recursive: true, force: true });
	});

	it('rejects a new run before detection, writer acquisition or authority issuance', async () => {
		const prepared = worktreeRetirement.prepare(checkout);
		if (!prepared.ok) throw new Error(prepared.reason);
		token = prepared.token;
		await expect(createPluginHeadlessAgentRunner(deps)(agent.id, 'hello')).rejects.toThrow(
			'Worktree retirement: worktree is preparing'
		);
		expect(deps.detectAgent).not.toHaveBeenCalled();
		expect(deps.spawn).not.toHaveBeenCalled();
		expect(deps.issueRunToken).not.toHaveBeenCalled();
	});

	it('holds admission synchronously while waiting for a provider writer', async () => {
		const release = await acquireProviderSessionWriter('codex', 'fixture-owner', 'fixture-session');
		const pending = createPluginHeadlessAgentRunner(deps)(agent.id, 'hello', 'fixture-session');
		try {
			expect(worktreeRetirement.prepare(checkout).ok).toBe(false);
			expect(deps.detectAgent).not.toHaveBeenCalled();
		} finally {
			release();
		}
		await pending;
		const prepared = worktreeRetirement.prepare(checkout);
		expect(prepared.ok).toBe(true);
		if (prepared.ok) token = prepared.token;
	});

	it.each(['resolve', 'reject'] as const)(
		'keeps cancelled preflight fenced until the underlying preparation %ss',
		async (outcome) => {
			let finish!: () => void;
			deps.detectAgent = vi.fn(async () => {
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				if (outcome === 'reject') throw new Error('late detection failure');
				return { available: true };
			});
			const controller = new AbortController();
			const pending = createPluginHeadlessAgentRunner(deps)(
				agent.id,
				'hello',
				undefined,
				controller.signal
			);
			controller.abort();
			await expect(pending).resolves.toMatchObject({ success: false, executionStarted: false });
			expect(worktreeRetirement.prepare(checkout).ok).toBe(false);
			finish();
			await new Promise(setImmediate);
			expect(deps.spawn).not.toHaveBeenCalled();
			const prepared = worktreeRetirement.prepare(checkout);
			expect(prepared.ok).toBe(true);
			if (prepared.ok) token = prepared.token;
		}
	);

	it('requires child exit for ordinary CLI sends and retains the fence after cancellation', async () => {
		let finish!: () => void;
		deps.spawn = vi.fn(async (_type, _cwd, _prompt, _session, options) => {
			expect(options?.requireProcessExit).toBe(true);
			options?.onProcessStarted?.(123);
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return { success: false, error: 'cancelled' };
		});
		const controller = new AbortController();
		const pending = createPluginHeadlessAgentRunner(deps)(
			agent.id,
			'hello',
			undefined,
			controller.signal
		);
		await new Promise(setImmediate);
		controller.abort();
		expect(worktreeRetirement.prepare(checkout).ok).toBe(false);
		finish();
		await pending;
		const prepared = worktreeRetirement.prepare(checkout);
		expect(prepared.ok).toBe(true);
		if (prepared.ok) token = prepared.token;
	});

	it.each(['unrelated', 'remote'] as const)(
		'allows %s headless work while reserved',
		async (location) => {
			const prepared = worktreeRetirement.prepare(checkout);
			if (!prepared.ok) throw new Error(prepared.reason);
			token = prepared.token;
			if (location === 'unrelated') {
				agent = { ...agent, cwd: join(fixture, 'other') };
				mkdirSync(agent.cwd);
			} else {
				agent = { ...agent, sessionSshRemoteConfig: { enabled: true, remoteId: 'fixture-remote' } };
			}
			await expect(createPluginHeadlessAgentRunner(deps)(agent.id, 'hello')).resolves.toMatchObject(
				{ success: true }
			);
		}
	);
});
