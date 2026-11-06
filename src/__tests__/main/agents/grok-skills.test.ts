import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, execFile } from 'child_process';
import { discoverGrokSlashCommands as discover } from '../../../main/agents/grok-skills';
import type { GrokCommandObservation } from '../../../main/agents/grok-skills';
import type { ModelDiscoveryContext } from '../../../main/agents/detector';
import { runProviderProbe } from '../../../main/agents/grok-probe';
import { startTurn } from '../../../shared/maestro-lib/run/start-turn';
import { captureException } from '../../../main/utils/sentry';
import { makeGrokCommandObservation } from '../../fixtures/grok-command-observation';
import { isolateAgentEnv } from '../../helpers/agentEnvIsolation';

vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/agents/grok-probe', () => ({ runProviderProbe: vi.fn() }));
vi.mock('../../../shared/maestro-lib/run/start-turn', () => ({ startTurn: vi.fn() }));
vi.mock('child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('fs', () => ({
	readFileSync: vi.fn(),
	readdirSync: vi.fn(() => ['hidden', 'disabled', 'other-account']),
	promises: { readFile: vi.fn(), readdir: vi.fn(() => ['hidden', 'disabled', 'other-account']) },
}));
// Avoid machine-specific PATH discovery while retaining the canonical env layers.
vi.mock('../../../shared/pathUtils', () => ({
	buildExpandedPath: () => '/usr/bin',
	detectNodeVersionManagerBinPaths: () => [],
}));

describe('Grok owned command discovery', () => {
	isolateAgentEnv(['GROK_HOME', 'GROK_AUTH', 'XAI_API_KEY']);
	let context: ModelDiscoveryContext;
	let owned: GrokCommandObservation;
	const read = vi.fn();
	const sessionId = 'native-session-1';

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
		context = {
			cwd: path.resolve('project-a'),
			customPath: path.resolve('bin', 'grok-custom'),
			model: 'grok-4.5',
			effort: 'high',
			target: { kind: 'local' },
			environment: {
				surface: 'desktop',
				agentCustomEnvVars: { GROK_HOME: path.resolve('account-default') },
				sessionCustomEnvVars: { GROK_HOME: path.resolve('account-a') },
			},
		};
		owned = makeGrokCommandObservation({ ...context, sessionId });
		read.mockReset().mockImplementation(() => owned);
	});

	afterEach(() => {
		for (const effect of [
			spawn,
			execFile,
			startTurn,
			runProviderProbe,
			fs.readFileSync,
			fs.readdirSync,
			fs.promises.readFile,
			fs.promises.readdir,
		]) {
			expect(effect).not.toHaveBeenCalled();
		}
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('preserves native precedence, qualified collisions and origins without reviving hidden skills', async () => {
		const scopes = ['repo', 'user', 'plugin', 'local', 'server', 'bundled'];
		owned = {
			...owned,
			commands: scopes.map((scope, i) => ({
				name: i === 0 ? 'review' : `${scope}:review`,
				description: scope,
				_meta: {
					scope,
					path: '/private/SKILL.md',
					bareName: 'review',
					qualifiedName: `${scope}:review`,
				},
			})),
		};
		const result = await discover(context, sessionId, read);
		expect(result.status).toBe('discovered');
		// The effective native catalog owns precedence and omits hidden/disabled entries.
		expect(result.commands).toEqual(
			scopes.map((scope, i) => ({
				name: i === 0 ? 'review' : `${scope}:review`,
				description: scope,
				kind: 'skill',
				scope,
				entryDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
			}))
		);
	});

	it('projects native commands and workflows without bodies, account paths or secret metadata', async () => {
		const secret = 'sk-' + 'x'.repeat(48);
		owned = {
			...owned,
			commands: [
				{
					name: 'compact',
					description: `\u001b[31mSummarize ${secret}\u001b[0m`,
					input: { hint: secret },
					body: 'PRIVATE BODY',
				},
				{
					name: 'flow',
					description: 'Workflow',
					_meta: { workflowSource: 'private-source', workflowPath: '/private/workflow' },
				},
			],
		};
		const result = await discover(context, sessionId, read);
		expect(result.commands).toEqual([
			{
				name: 'compact',
				kind: 'native-command',
				description: 'Summarize [REDACTED_API_KEY]',
				argumentHint: '[REDACTED_API_KEY]',
				entryDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
			{
				name: 'flow',
				kind: 'workflow',
				description: 'Workflow',
				entryDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
		]);
		// The digest names the raw entry, so a body or secret change is a different command.
		expect(result.commands[0].entryDigest).not.toBe(result.commands[1].entryDigest);
		// Opaque account and host references bind a native command intent; only there.
		expect(result.binding).toMatchObject({ account: owned.account, host: owned.host });
		const { account: _account, host: _host, ...unscoped } = result.binding!;
		expect(JSON.stringify({ ...result, binding: unscoped })).not.toMatch(
			/synthetic-account|synthetic-host/
		);
		expect(JSON.stringify(result)).not.toContain(secret);
		expect(JSON.stringify(result)).not.toMatch(
			/PRIVATE BODY|\/private|private-source|GROK_HOME|prompt|login/
		);
	});

	it.each(['account', 'cwd', 'binary', 'model', 'effort', 'generation'])(
		'refuses a changed selected %s',
		async (field) => {
			if (field === 'account')
				context.environment.sessionCustomEnvVars = { GROK_HOME: path.resolve('account-b') };
			if (field === 'cwd') context.cwd = path.resolve('project-b');
			if (field === 'binary') context.customPath = path.resolve('other-bin', 'grok');
			if (field === 'model') context.model = 'grok-other';
			if (field === 'effort') context.effort = 'low';
			if (field === 'generation') context.configGeneration = 'config-2';
			expect(await discover(context, sessionId, read)).toEqual({
				status: 'unavailable',
				commands: [],
				reason: 'observation-unavailable',
			});
		}
	);

	it.each<Partial<GrokCommandObservation>>([
		{ protocolVersion: 2 },
		{ sessionId: 'another-native-session' },
		{ agentVersion: '' },
		{ processGeneration: 'sk-' + 'x'.repeat(48) },
		{ catalogRevision: 0.5 },
		{ observedAt: Date.parse('2026-10-31T12:00:01Z') },
	])('refuses invalid/stale observation %j', async (override) => {
		owned = { ...owned, ...override };
		expect((await discover(context, sessionId, read)).reason).toBe('observation-unavailable');
	});

	it.each(['1.0.70', '1.0.71'])(
		'retains observed version %s without certifying a version range',
		async (agentVersion) => {
			owned = { ...owned, agentVersion };
			expect((await discover(context, sessionId, read)).binding?.agentVersion).toBe(agentVersion);
		}
	);

	it.each(
		[
			null,
			[],
			{ name: '../escape', description: '' },
			{ name: 'bad::name', description: '' },
			{ name: 'review', description: 1 },
			{ name: 'review', description: '', input: {} },
			{ name: 'review', description: '', _meta: [] },
			{ name: 'review', description: '', _meta: { hidden: true } },
			{ name: 'review', description: '', _meta: { disabled: true } },
			{
				name: 'review',
				description: '',
				_meta: {
					scope: 'unknown',
					path: '/skill',
					bareName: 'review',
					qualifiedName: 'user:review',
				},
			},
			{ name: 'review', description: '', _meta: { scope: 'repo' } },
			{ name: 'review', description: '', _meta: { workflowSource: 'repo' } },
			{ name: 'x'.repeat(129), description: '' },
			{ name: 'review', description: 'x'.repeat(4097) },
			{ name: 'review', description: '', input: { hint: 'x'.repeat(1025) } },
		].map((entry) => [entry])
	)('rejects malformed or unknown metadata without partial results: %j', async (entry) => {
		owned = { ...owned, commands: [{ name: 'valid', description: 'Valid command' }, entry] };
		expect(await discover(context, sessionId, read)).toEqual({
			status: 'unavailable',
			commands: [],
			reason: 'invalid-catalog',
		});
	});

	it('refuses duplicate invocation names and oversized catalogs', async () => {
		for (const commands of [
			[...owned.commands, ...owned.commands],
			Array.from({ length: 257 }, (_, i) => ({ name: `command-${i}`, description: '' })),
		]) {
			owned = { ...owned, commands };
			expect((await discover(context, sessionId, read)).reason).toBe('invalid-catalog');
		}
	});

	it('distinguishes authoritative empty, missing and expired observations without a cache', async () => {
		owned = { ...owned, commands: [] };
		expect(await discover(context, sessionId, read)).toMatchObject({
			status: 'discovered',
			commands: [],
			binding: { route: 'grok-acp' },
		});
		vi.advanceTimersByTime(30_000);
		expect((await discover(context, sessionId, read)).reason).toBe('observation-unavailable');
		read.mockReturnValue(undefined);
		expect((await discover(context, sessionId, read)).reason).toBe('observation-unavailable');
	});

	it('refuses an unavailable executable instead of searching PATH or probing', async () => {
		owned.launch.command = 'grok';
		expect((await discover(context, sessionId, read)).reason).toBe('executable-unavailable');
	});

	it.each(['before', 'during'])('refuses cancellation %s the owner read', async (when) => {
		const controller = new AbortController();
		context.signal = controller.signal;
		if (when === 'before') controller.abort();
		else
			read.mockImplementation(() => {
				controller.abort();
				return owned;
			});
		expect((await discover(context, sessionId, read)).reason).toBe('canceled');
		expect(read).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
	});

	it('sanitizes owner failures and passes a detached selection', async () => {
		read.mockImplementation((selection) => {
			selection.environment.sessionCustomEnvVars.GROK_HOME = 'mutated';
			throw new Error('PRIVATE ACCOUNT BODY');
		});
		expect((await discover(context, sessionId, read)).reason).toBe('observation-unavailable');
		expect(context.environment.sessionCustomEnvVars?.GROK_HOME).toBe(path.resolve('account-a'));
		expect(captureException).toHaveBeenCalledWith(
			new Error('Grok command observation unavailable'),
			{ operation: 'discoverGrokSlashCommands' }
		);
	});
});
