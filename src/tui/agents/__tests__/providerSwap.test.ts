import { describe, expect, it } from 'vitest';
import type { AgentRecord, ProviderInfo } from '../../../shared/maestro-lib';
import {
	loadProviderChoices,
	providerChoices,
	providerPickerStart,
	submitProviderSwap,
} from '../providerSwap';
import { createFakeClient } from '../../__tests__/fakeClient';

const PROVIDERS: ProviderInfo[] = [
	{ id: 'claude-code', name: 'Claude Code', available: true, version: '2.1.0' },
	{ id: 'codex', name: 'Codex', available: true },
	{ id: 'opencode', name: 'OpenCode', available: false },
	{ id: 'terminal', name: 'Terminal', available: true },
];

const AGENT: AgentRecord = { id: 'a1', name: 'Alpha', toolType: 'codex' };

describe('provider choices (PS-4)', () => {
	it('offers installed providers only, never the terminal, and marks the current one', () => {
		expect(providerChoices(PROVIDERS, AGENT)).toEqual([
			{ id: 'claude-code', label: 'Claude Code 2.1.0', current: false },
			{ id: 'codex', label: 'Codex', current: true },
		]);
	});

	it('opens on the current provider, else the first row', () => {
		expect(providerPickerStart(providerChoices(PROVIDERS, AGENT))).toBe(1);
		expect(providerPickerStart(providerChoices(PROVIDERS, { ...AGENT, toolType: 'gone' }))).toBe(0);
		expect(providerPickerStart([])).toBe(0);
	});

	it('probes the SSH remote the agent runs on, and only then', async () => {
		const fake = createFakeClient({ providers: PROVIDERS });
		await loadProviderChoices(fake.client, AGENT);
		await loadProviderChoices(fake.client, {
			...AGENT,
			sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
		});
		expect(fake.requests).toEqual([
			{ method: 'providers.list', args: [undefined] },
			{ method: 'providers.list', args: [{ sshRemoteId: 'r1' }] },
		]);
	});

	it('passes the host failure through', async () => {
		const failing = {
			providers: { list: async () => ({ ok: false as const, error: { code: 'failed' } }) },
		};
		const result = await loadProviderChoices(failing as never, AGENT);
		expect(result.ok).toBe(false);
	});
});

describe('submitProviderSwap (PS-1)', () => {
	const choices = providerChoices(PROVIDERS, AGENT);

	it('sends one update with the provider and returns what the host could not park', async () => {
		const fake = createFakeClient({ updateNotices: ['A queued message lost its model.'] });
		const result = await submitProviderSwap(fake.client, AGENT, choices, 0);
		expect(fake.requests).toEqual([
			{ method: 'agents.update', args: ['a1', { provider: 'claude-code' }] },
		]);
		expect(result).toEqual({
			ok: true,
			value: {
				summary: 'Switched Alpha to Claude Code. Every tab was kept.',
				notices: ['A queued message lost its model.'],
			},
		});
	});

	it('has no notices when the host parked everything', async () => {
		const fake = createFakeClient();
		const result = await submitProviderSwap(fake.client, AGENT, choices, 0);
		expect(result).toMatchObject({ ok: true, value: { notices: [] } });
	});

	it('sends nothing for the provider the agent is already on', async () => {
		const fake = createFakeClient();
		const result = await submitProviderSwap(fake.client, AGENT, choices, 1);
		expect(fake.requests).toEqual([]);
		expect(result).toEqual({
			ok: true,
			value: { summary: 'Alpha is already on Codex.', notices: [] },
		});
	});

	it('reports a refusal and a row that vanished', async () => {
		const fake = createFakeClient({ failures: { 'agents.update': 'rejected' } });
		expect(await submitProviderSwap(fake.client, AGENT, choices, 0)).toMatchObject({
			ok: false,
			error: { code: 'rejected' },
		});
		expect(await submitProviderSwap(fake.client, AGENT, choices, 9)).toMatchObject({
			ok: false,
			error: { code: 'invalid', message: 'That provider is gone.' },
		});
	});
});
