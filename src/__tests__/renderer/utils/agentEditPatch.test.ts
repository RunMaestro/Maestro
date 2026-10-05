import { describe, expect, it } from 'vitest';

import { buildAgentEditPatch, type AgentEditForm } from '../../../renderer/utils/agentEditPatch';
import type { Session } from '../../../renderer/types';

const agent = (extra: Record<string, unknown> = {}) =>
	({
		id: 'a1',
		name: 'Alpha',
		toolType: 'claude-code',
		cwd: '/work',
		aiTabs: [],
		...extra,
	}) as unknown as Session;

/** The form Edit Agent hands back for an agent nobody changed: the same name, every other field blank. */
const form = (extra: Partial<AgentEditForm> = {}): AgentEditForm => ({ name: 'Alpha', ...extra });

describe('buildAgentEditPatch', () => {
	it('says nothing for a save that changed nothing', () => {
		expect(buildAgentEditPatch(agent(), form())).toEqual({});
		const configured = agent({
			nudgeMessage: 'n',
			customPath: '/bin/claude',
			customEnvVars: { A: '1' },
			customModel: 'opus',
			additionalDirectories: [{ path: '/x', read: true, write: false }],
			retryOnTokenExhaustion: false,
			sessionSshRemoteConfig: { enabled: false, remoteId: null },
		});
		expect(
			buildAgentEditPatch(
				configured,
				form({
					nudgeMessage: 'n',
					customPath: '/bin/claude',
					customEnvVars: { A: '1' },
					customModel: 'opus',
					additionalDirectories: [{ path: '/x', read: true, write: false }],
					retryOnTokenExhaustion: false,
					sessionSshRemoteConfig: { enabled: false, remoteId: null },
				})
			)
		).toEqual({});
	});

	it('names only what changed', () => {
		const patch = buildAgentEditPatch(
			agent({ nudgeMessage: 'old', customModel: 'opus' }),
			form({ name: 'Renamed', nudgeMessage: 'new', customModel: 'opus' })
		);
		expect(patch).toEqual({ name: 'Renamed', nudgeMessage: 'new' });
	});

	it('turns a field the form left blank into a clear', () => {
		const patch = buildAgentEditPatch(
			agent({
				nudgeMessage: 'n',
				newSessionMessage: 'm',
				customPath: '/p',
				customArgs: '--x',
				customEnvVars: { A: '1' },
				customEnvVarsDisabled: { B: '2' },
				customModel: 'opus',
				customEffort: 'high',
				enableMaestroP: true,
				maestroPPath: '/mp',
				maestroPMode: 'dynamic',
				retryOnAvailabilityErrors: false,
				additionalDirectories: [{ path: '/x', read: true, write: true }],
				codexAutoResetOnExhaustion: true,
			}),
			form()
		);
		expect(patch).toEqual({
			nudgeMessage: null,
			newSessionMessage: null,
			customPath: null,
			customArgs: null,
			env: null,
			envDisabled: null,
			model: null,
			effort: null,
			enableMaestroP: null,
			maestroPPath: null,
			maestroPMode: null,
			retryOnAvailabilityErrors: null,
			additionalDirectories: null,
			codexAutoResetOnExhaustion: null,
		});
	});

	it('keeps an explicit false for the Claude token source, which is a choice and not an unset', () => {
		const patch = buildAgentEditPatch(agent(), form({ enableMaestroP: false }));
		expect(patch).toEqual({ enableMaestroP: false });
	});

	it('stores the Codex reset only when on, and clears it when the form drops it', () => {
		expect(buildAgentEditPatch(agent(), form({ codexAutoResetOnExhaustion: true }))).toEqual({
			codexAutoResetOnExhaustion: true,
		});
		expect(
			buildAgentEditPatch(
				agent({ codexAutoResetOnExhaustion: true }),
				form({ codexAutoResetOnExhaustion: false })
			)
		).toEqual({ codexAutoResetOnExhaustion: null });
		// Off on both sides is no change, whichever spelling of off.
		expect(
			buildAgentEditPatch(
				agent({ codexAutoResetOnExhaustion: false }),
				form({ codexAutoResetOnExhaustion: undefined })
			)
		).toEqual({});
	});

	it('carries the new working directory as cwd', () => {
		expect(buildAgentEditPatch(agent(), form({ workingDirectory: '/elsewhere' }))).toEqual({
			cwd: '/elsewhere',
		});
	});

	describe('the context window and its provenance', () => {
		it('leaves a value the form round-tripped alone, whatever provenance it had', () => {
			const held = agent({ customContextWindow: 200000 });
			expect(buildAgentEditPatch(held, form({ customContextWindow: 200000 }))).toEqual({});
		});

		it('sends a value the person set, which the runtime records as theirs', () => {
			expect(
				buildAgentEditPatch(
					agent({ customContextWindow: 200000 }),
					form({ customContextWindow: 1000000, contextWindowSource: 'user-edited' })
				)
			).toEqual({ contextWindow: 1000000 });
		});

		it('clears the value, and with it the provenance, when the field was emptied', () => {
			expect(
				buildAgentEditPatch(
					agent({ customContextWindow: 200000, contextWindowSource: 'user-edited' }),
					form()
				)
			).toEqual({ contextWindow: null });
			expect(buildAgentEditPatch(agent(), form())).toEqual({});
		});
	});

	describe('ssh', () => {
		it('sends the config when it changed, with the keys the form dropped cleared as a replace would', () => {
			const held = agent({
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'r1',
					workingDirOverride: '/remote',
					syncHistory: true,
				},
			});
			const patch = buildAgentEditPatch(
				held,
				form({
					sessionSshRemoteConfig: {
						enabled: false,
						remoteId: null,
						shareHistoryToProjectDir: true,
					},
				})
			);
			expect(patch.ssh).toEqual({
				enabled: false,
				remoteId: null,
				shareHistoryToProjectDir: true,
				workingDirOverride: undefined,
				syncHistory: undefined,
			});
			expect(Object.keys(patch.ssh ?? {})).toContain('workingDirOverride');
		});

		it('sends the config for an agent that never had one', () => {
			const patch = buildAgentEditPatch(
				agent(),
				form({
					sessionSshRemoteConfig: { enabled: true, remoteId: 'r1', workingDirOverride: '/r' },
				})
			);
			expect(patch.ssh).toEqual({ enabled: true, remoteId: 'r1', workingDirOverride: '/r' });
		});

		it('says nothing for an identical config', () => {
			const held = agent({
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'r1',
					workingDirOverride: '/r',
					syncHistory: false,
				},
			});
			expect(
				buildAgentEditPatch(
					held,
					form({
						sessionSshRemoteConfig: {
							enabled: true,
							remoteId: 'r1',
							workingDirOverride: '/r',
							syncHistory: false,
						},
					})
				)
			).toEqual({});
		});
	});

	describe('a provider change', () => {
		const onClaude = () =>
			agent({
				customPath: '/claude',
				customModel: 'opus',
				providerOverrides: { codex: { customModel: 'gpt-5', customPath: '/codex' } },
			});

		it('names the provider and sends every override field, since the form was seeded from the incoming provider', () => {
			const patch = buildAgentEditPatch(
				onClaude(),
				form({ toolType: 'codex', customModel: 'gpt-5', customPath: '/codex' })
			);
			expect(patch).toMatchObject({
				provider: 'codex',
				model: 'gpt-5',
				customPath: '/codex',
				// Blank on the form: sent as a clear even though the live (Claude) value is also blank.
				customArgs: null,
				env: null,
				effort: null,
			});
		});

		it('measures the context window against what the incoming provider parked, not the live one', () => {
			const away = agent({
				customContextWindow: 200000,
				providerOverrides: { codex: { customContextWindow: 400000 } },
			});
			// Unchanged from the parked seed: nothing to send for it.
			expect(
				buildAgentEditPatch(away, form({ toolType: 'codex', customContextWindow: 400000 }))
					.contextWindow
			).toBeUndefined();
			// Emptied: the parked value is what gets cleared.
			expect(buildAgentEditPatch(away, form({ toolType: 'codex' })).contextWindow).toBeNull();
		});

		it('leaves the agent-level settings alone, measuring them against the live record', () => {
			const patch = buildAgentEditPatch(
				agent({ retryOnTokenExhaustion: true }),
				form({ toolType: 'codex', retryOnTokenExhaustion: true })
			);
			expect(patch.retryOnTokenExhaustion).toBeUndefined();
			expect(patch.provider).toBe('codex');
		});

		it('is not a provider change when the form names the provider the agent is already on', () => {
			expect(buildAgentEditPatch(agent(), form({ toolType: 'claude-code' }))).toEqual({});
		});
	});
});
