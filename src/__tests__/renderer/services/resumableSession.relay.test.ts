import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	loadResumableSession,
	matchesNativeSessionBinding,
	SessionResumeRefusedError,
	type LoadResumableSessionOptions,
} from '../../../renderer/services/resumableSession';
import {
	matchesNativeSessionBinding as sharedMatchesNativeSessionBinding,
	type NativeSessionBinding,
} from '../../../shared/maestro-lib/agents/providerSwap';
import type { SessionMessagesResult } from '../../../main/agents/session-storage';

describe('reopened Relay origin', () => {
	it.each(['claude-code', 'codex', 'opencode'] as const)(
		'loads durable origin for %s even with provided messages',
		async (toolType) => {
			vi.mocked(window.maestro.claude.getSessionOrigins).mockResolvedValue({
				'provider-session': { origin: 'relay' },
			});
			vi.mocked(window.maestro.agentSessions.getOrigins).mockResolvedValue({
				'provider-session': { origin: 'relay' },
			});
			const resumed = await loadResumableSession({
				toolType,
				projectRoot: '/project',
				agentSessionId: 'provider-session',
				providedMessages: [{ id: 'log', timestamp: 1, source: 'user', text: 'hello' }],
			});
			expect(resumed).toMatchObject({ origin: 'relay' });
		}
	);
});

describe('Grok native resume receipts', () => {
	const binding = {
		version: 1,
		state: 'bound',
		provider: 'grok',
		nativeSessionId: 'provider-session',
		accountRef: 'account-a',
		host: { kind: 'ssh', identity: 'endpoint-a' },
		cwd: '/project',
	} as const satisfies NativeSessionBinding;
	const options: LoadResumableSessionOptions = {
		toolType: 'grok',
		projectRoot: '/project',
		agentSessionId: 'provider-session',
		ownerAgentId: 'owner-a',
		sshRemoteId: 'remote-a',
		nativeSessionBinding: binding,
		providedMessages: [{ id: 'retained', timestamp: 1, source: 'user', text: 'retained' }],
	};
	const receipt: SessionMessagesResult = {
		messages: [
			{ type: 'user', content: 'native', timestamp: '2026-10-31T00:00:00Z', uuid: 'native-log' },
		],
		total: 1,
		hasMore: false,
		source: { provider: 'grok', status: 'available' },
		nativeSessionBinding: binding,
	};
	const read = vi.mocked(window.maestro.agentSessions.read);
	beforeEach(() => vi.clearAllMocks());

	it('keeps the renderer compatibility export on the shared matcher', () => {
		expect(matchesNativeSessionBinding).toBe(sharedMatchesNativeSessionBinding);
		expect(matchesNativeSessionBinding(binding, structuredClone(binding))).toBe(true);
	});

	it.each([
		...[
			{ provider: 'codex' },
			{ nativeSessionId: 'other' },
			{ accountRef: 'account-b' },
			{ cwd: '/other' },
			{ host: { kind: 'ssh', identity: 'endpoint-b' } },
			{ host: { kind: 'local', identity: 'endpoint-a' } },
		].map((change) => ({
			nativeSessionBinding: { ...binding, ...change } as NativeSessionBinding,
		})),
		{ source: undefined },
		{ source: { provider: 'grok', status: 'unavailable' } },
		{ source: { provider: 'grok', status: 'partial' } },
		{ source: { provider: 'codex', status: 'available' } },
		{ nativeSessionBinding: undefined },
		{ nativeSessionBinding: { version: 1, state: 'unknown', reason: 'legacy' } },
	] as const)('refuses unverified receipts with supplied logs: %j', async (change) => {
		if ('nativeSessionBinding' in change)
			expect(matchesNativeSessionBinding(binding, change.nativeSessionBinding)).toBe(false);
		read.mockResolvedValue({ ...receipt, ...change });
		await expect(loadResumableSession(options)).rejects.toBeInstanceOf(SessionResumeRefusedError);
		expect(window.maestro.agentSessions.getOrigins).not.toHaveBeenCalled();
		expect(window.maestro.claude.getSessionOrigins).not.toHaveBeenCalled();
	});

	it.each([
		undefined,
		{ version: 1, state: 'unknown', reason: 'legacy' },
		{ ...binding, version: 2 },
		{ ...binding, host: undefined },
		{ ...binding, host: { kind: 'other', identity: 'endpoint-a' } },
		...['provider', 'nativeSessionId', 'accountRef', 'cwd'].flatMap((field) =>
			['', ' ', 'bad\0value', 42].map((value) => ({ ...binding, [field]: value }))
		),
		{ ...binding, host: { kind: 'ssh', identity: '' } },
	])('rejects unknown or malformed ownership before reading: %j', async (invalid) => {
		const nativeSessionBinding = invalid as NativeSessionBinding | undefined;
		expect(matchesNativeSessionBinding(nativeSessionBinding, nativeSessionBinding)).toBe(false);
		await expect(loadResumableSession({ ...options, nativeSessionBinding })).rejects.toBeInstanceOf(
			SessionResumeRefusedError
		);
		expect(read).not.toHaveBeenCalled();
	});

	it('forwards the owner and isolated binding, validates native messages, and retains scoped metadata', async () => {
		const selected = structuredClone(binding);
		read.mockResolvedValue(receipt);
		const resumed = await loadResumableSession({
			...options,
			nativeSessionBinding: selected,
			sessionName: 'Recorded title',
			starred: true,
		});
		expect(read).toHaveBeenCalledWith(
			'grok',
			'/project',
			'provider-session',
			expect.objectContaining({ ownerAgentId: 'owner-a', nativeSessionBinding: binding }),
			'remote-a'
		);
		const sent = read.mock.calls[0][3]!.nativeSessionBinding;
		expect(sent).not.toBe(selected);
		expect(resumed?.nativeSessionBinding).not.toBe(selected);
		expect(resumed?.nativeSessionBinding).not.toBe(sent);
		const { host, ...rest } = binding;
		expect(matchesNativeSessionBinding(binding, { host, ...rest })).toBe(true);
		expect(resumed).toMatchObject({
			name: 'Recorded title',
			starred: true,
			nativeSessionBinding: binding,
			messages: [{ id: 'native-log', text: 'native' }],
		});
		expect(window.maestro.agentSessions.getOrigins).not.toHaveBeenCalled();
		expect(window.maestro.claude.getSessionOrigins).not.toHaveBeenCalled();
	});
});
