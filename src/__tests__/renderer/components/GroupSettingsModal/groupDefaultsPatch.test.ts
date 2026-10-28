/**
 * Tests for applying a typed patch to a group's defaults: the same profile the
 * Group Settings dialog would have saved for the same edit, and a refusal by
 * name for every value the dialog's builder would otherwise drop in silence.
 */

import { describe, it, expect } from 'vitest';
import {
	applyGroupDefaultsPatch,
	type GroupDefaultsPatchContext,
} from '../../../../renderer/components/GroupSettingsModal/groupDefaultsPatch';
import type { GroupAgentDefaults } from '../../../../shared/types';

const CONTEXT: GroupDefaultsPatchContext = {
	homeDir: '/Users/test',
	endpoints: [
		{
			id: 'ollama',
			name: 'Ollama',
			kind: 'ollama',
			baseUrl: 'http://127.0.0.1:11434',
		} as never,
	],
	sshRemotes: [{ id: 'remote-1', name: 'Build box' }],
	liveAgentIds: ['agent-a', 'agent-b'],
};

function apply(
	current: GroupAgentDefaults | undefined,
	configPatch: Record<string, unknown>,
	sshPatch?: Record<string, unknown>,
	context: GroupDefaultsPatchContext = CONTEXT
) {
	return applyGroupDefaultsPatch(current, { configPatch, sshPatch }, context);
}

function defaultsOf(result: ReturnType<typeof apply>): GroupAgentDefaults | undefined {
	if (!result.ok) throw new Error(result.error);
	return result.defaults;
}

describe('applyGroupDefaultsPatch', () => {
	describe('plain fields', () => {
		it('sets a nudge and a new session message on an empty profile', () => {
			const defaults = defaultsOf(
				apply(undefined, { nudgeMessage: 'Be brief.', newSessionMessage: 'Hello.' })
			);
			expect(defaults).toEqual({ nudgeMessage: 'Be brief.', newSessionMessage: 'Hello.' });
		});

		it('clears a field with null and leaves the rest', () => {
			const defaults = defaultsOf(
				apply({ nudgeMessage: 'Be brief.', newSessionMessage: 'Hello.' }, { nudgeMessage: null })
			);
			expect(defaults).toEqual({ newSessionMessage: 'Hello.' });
		});

		it('returns undefined when the patch leaves no opinion at all', () => {
			const defaults = defaultsOf(apply({ nudgeMessage: 'Be brief.' }, { nudgeMessage: null }));
			expect(defaults).toBeUndefined();
		});

		it('replaces the env map and unparks a variable it names', () => {
			const defaults = defaultsOf(
				apply(
					{ customEnvVars: { OLD: '1' }, customEnvVarsDisabled: { FOO: 'parked' } },
					{ customEnvVars: { FOO: 'live' } }
				)
			);
			expect(defaults?.customEnvVars).toEqual({ FOO: 'live' });
			expect(defaults?.customEnvVarsDisabled).toBeUndefined();
		});

		it('refuses a mistyped value by name', () => {
			const result = apply(undefined, { nudgeMessage: 5 });
			expect(result).toEqual({ ok: false, error: 'nudgeMessage must be a string or null.' });
		});
	});

	describe('provider', () => {
		it('sets the provider and a model on it in one call', () => {
			const defaults = defaultsOf(
				apply(undefined, { toolType: 'claude-code', customModel: 'opus', customEffort: 'high' })
			);
			expect(defaults).toMatchObject({
				toolType: 'claude-code',
				customModel: 'opus',
				customEffort: 'high',
			});
		});

		it('resets provider-bound values when the provider changes, and keeps env vars', () => {
			const defaults = defaultsOf(
				apply(
					{
						toolType: 'claude-code',
						customModel: 'opus',
						customPath: '/bin/claude',
						customEnvVars: { CLAUDE_CONFIG_DIR: '/x' },
					},
					{ toolType: 'codex' }
				)
			);
			expect(defaults).toEqual({ toolType: 'codex', customEnvVars: { CLAUDE_CONFIG_DIR: '/x' } });
		});

		it('refuses a provider that is not pickable', () => {
			expect(apply(undefined, { toolType: 'terminal' }).ok).toBe(false);
			expect(apply(undefined, { toolType: 'nope' }).ok).toBe(false);
		});

		it('refuses a model when the group has no provider, instead of dropping it', () => {
			const result = apply(undefined, { customModel: 'opus' });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain('--model');
		});

		it('clears the provider and everything bound to it with null', () => {
			const defaults = defaultsOf(
				apply(
					{ toolType: 'claude-code', customModel: 'opus', nudgeMessage: 'N' },
					{ toolType: null }
				)
			);
			expect(defaults).toEqual({ nudgeMessage: 'N' });
		});

		it('refuses the Claude token source on another provider', () => {
			const result = apply({ toolType: 'codex' }, { enableMaestroP: true });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain('Claude Code');
		});

		it('refuses the Codex transport on another provider', () => {
			const result = apply({ toolType: 'claude-code' }, { codexTransport: 'app-server' });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain('Codex');
		});

		it('stores the Codex app-server transport on Codex', () => {
			const defaults = defaultsOf(apply({ toolType: 'codex' }, { codexTransport: 'app-server' }));
			expect(defaults?.codexTransport).toBe('app-server');
		});
	});

	describe('context window', () => {
		it('stores a positive window and clears it with null', () => {
			const set = defaultsOf(apply({ toolType: 'claude-code' }, { customContextWindow: 500000 }));
			expect(set?.customContextWindow).toBe(500000);
			const cleared = defaultsOf(apply(set, { customContextWindow: null }));
			expect(cleared?.customContextWindow).toBeUndefined();
		});

		it('refuses a window that is not a positive number', () => {
			expect(apply({ toolType: 'claude-code' }, { customContextWindow: -1 }).ok).toBe(false);
			expect(apply({ toolType: 'claude-code' }, { customContextWindow: 'big' }).ok).toBe(false);
		});
	});

	describe('Models', () => {
		it('merges a tier patch onto the tiers the profile holds', () => {
			const defaults = defaultsOf(
				apply(
					{
						toolType: 'claude-code',
						tierTargets: { low: { type: 'provider-model', model: 'haiku' } },
					},
					{ tierTargets: { high: { type: 'provider-model', model: 'opus' } } }
				)
			);
			expect(defaults?.tierTargets).toEqual({
				low: { type: 'provider-model', model: 'haiku' },
				high: { type: 'provider-model', model: 'opus' },
			});
		});

		it('clears one tier with null', () => {
			const defaults = defaultsOf(
				apply(
					{
						toolType: 'claude-code',
						tierTargets: {
							low: { type: 'provider-model', model: 'haiku' },
							high: { type: 'provider-model', model: 'opus' },
						},
					},
					{ tierTargets: { low: null } }
				)
			);
			expect(defaults?.tierTargets).toEqual({ high: { type: 'provider-model', model: 'opus' } });
		});

		it('refuses a Run on source that is not saved', () => {
			const result = apply(
				{ toolType: 'claude-code' },
				{
					runOn: {
						type: 'source',
						endpointId: 'missing',
						model: 'qwen3',
						contextTokens: 65536,
					},
				}
			);
			expect(result.ok).toBe(false);
		});

		it('clears Run on with null', () => {
			const withRunOn = defaultsOf(
				apply(
					{ toolType: 'claude-code' },
					{
						runOn: {
							type: 'source',
							endpointId: 'ollama',
							model: 'qwen3',
							contextTokens: 65536,
						},
					}
				)
			);
			expect(withRunOn?.runOn).toMatchObject({ type: 'source', endpointId: 'ollama' });
			const cleared = defaultsOf(apply(withRunOn, { runOn: null }));
			expect(cleared?.runOn).toBeUndefined();
		});

		it('stores the proxy mode in place of a gateway, and a gateway in place of the mode', () => {
			const onProxy = defaultsOf(
				apply({ toolType: 'claude-code' }, { tokenProxyMode: 'compress' })
			);
			expect(onProxy?.tokenProxyMode).toBe('compress');
			expect(onProxy?.gatewayUrl).toBeUndefined();

			const onGateway = defaultsOf(apply(onProxy, { gatewayUrl: 'http://127.0.0.1:4000' }));
			expect(onGateway?.tokenProxyMode).toBeUndefined();
			expect(onGateway?.gatewayUrl).toBe('http://127.0.0.1:4000');
		});

		it('refuses a gateway and a proxy mode in one patch', () => {
			const result = apply(
				{ toolType: 'claude-code' },
				{ gatewayUrl: 'http://127.0.0.1:4000', tokenProxyMode: 'compress' }
			);
			expect(result.ok).toBe(false);
		});

		it('refuses background requests while the proxy is off', () => {
			const result = apply(
				{ toolType: 'claude-code' },
				{
					backgroundRequests: {
						target: {
							type: 'source',
							endpointId: 'ollama',
							model: 'qwen3',
							contextTokens: 65536,
						},
					},
				}
			);
			expect(result.ok).toBe(false);
		});

		it('refuses an unknown proxy mode by listing the modes', () => {
			const result = apply({ toolType: 'claude-code' }, { tokenProxyMode: 'sideways' });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain('passthrough');
		});

		it('stores the System One opt-out and clears it with null', () => {
			const off = defaultsOf(apply(undefined, { systemOneOptOut: true }));
			expect(off?.systemOneOptOut).toBe(true);
			expect(defaultsOf(apply(off, { systemOneOptOut: null }))).toBeUndefined();
		});
	});

	describe('peers', () => {
		it('upserts a row, adds a note, and sets the derived grants', () => {
			const defaults = defaultsOf(
				apply(undefined, {
					peerAgentEdits: {
						upsert: [{ sessionId: 'agent-a', read: true, write: false }],
						notes: [{ sessionId: 'agent-a', description: 'The reviewer.' }],
					},
					groupPeerAccess: { read: true, write: false },
				})
			);
			expect(defaults?.peerAgents).toEqual([
				{ sessionId: 'agent-a', read: true, write: false, description: 'The reviewer.' },
			]);
			expect(defaults?.groupPeerAccess).toEqual({ read: true, write: false });
		});

		it('removes a row and keeps a none row as an exclusion', () => {
			const defaults = defaultsOf(
				apply(
					{
						peerAgents: [
							{ sessionId: 'agent-a', read: true, write: true },
							{ sessionId: 'agent-b', read: true, write: false },
						],
					},
					{
						peerAgentEdits: {
							remove: ['agent-a'],
							upsert: [{ sessionId: 'agent-b', read: false, write: false }],
						},
					}
				)
			);
			expect(defaults?.peerAgents).toEqual([{ sessionId: 'agent-b', read: false, write: false }]);
		});

		it('refuses a peer that is not a live agent', () => {
			const result = apply(undefined, {
				peerAgentEdits: { upsert: [{ sessionId: 'ghost', read: true, write: false }] },
			});
			expect(result).toEqual({ ok: false, error: 'Peer "ghost" is not an agent.' });
		});

		it('refuses a note on a peer with no row', () => {
			const result = apply(undefined, {
				peerAgentEdits: { notes: [{ sessionId: 'agent-a', description: 'Hi' }] },
			});
			expect(result.ok).toBe(false);
		});

		it('refuses a grant with neither bit', () => {
			expect(apply(undefined, { groupPeerAccess: { read: false, write: false } }).ok).toBe(false);
		});
	});

	describe('SSH', () => {
		it('sets a remote by id or by name', () => {
			const byId = defaultsOf(apply(undefined, {}, { enabled: true, remoteId: 'remote-1' }));
			expect(byId?.sessionSshRemoteConfig).toMatchObject({ enabled: true, remoteId: 'remote-1' });
			const byName = defaultsOf(apply(undefined, {}, { enabled: true, remoteId: 'Build box' }));
			expect(byName?.sessionSshRemoteConfig).toMatchObject({ remoteId: 'remote-1' });
		});

		it('refuses a remote that is not saved, naming the saved ones', () => {
			const result = apply(undefined, {}, { enabled: true, remoteId: 'nope' });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain('remote-1');
		});

		it('merges a working directory override onto the remote the profile holds', () => {
			const defaults = defaultsOf(
				apply(
					{ sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } },
					{},
					{ workingDirOverride: '/srv/app' }
				)
			);
			expect(defaults?.sessionSshRemoteConfig).toMatchObject({
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/srv/app',
			});
		});

		it('reverts to local execution', () => {
			const defaults = defaultsOf(
				apply(
					{
						nudgeMessage: 'N',
						sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
					},
					{},
					{ enabled: false, remoteId: null }
				)
			);
			expect(defaults).toEqual({ nudgeMessage: 'N' });
		});

		it('refuses the proxy for an agent on a remote', () => {
			const result = apply(
				{
					toolType: 'claude-code',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				},
				{ tokenProxyMode: 'compress' }
			);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain('Build box');
		});
	});

	describe('working directory', () => {
		it('stores an absolute path and refuses a relative one by the dialog rule', () => {
			expect(defaultsOf(apply(undefined, { projectRoot: '/work/app' }))?.projectRoot).toBe(
				'/work/app'
			);
			const relative = apply(undefined, { projectRoot: 'app' });
			expect(relative.ok).toBe(false);
			if (!relative.ok) expect(relative.error).toContain('absolute');
		});
	});
});
