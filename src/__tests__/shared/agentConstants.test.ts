/**
 * Tests for shared/agentConstants.ts - Context windows and shared constants
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_CONTEXT_WINDOWS,
	FALLBACK_CONTEXT_WINDOW,
	COMBINED_CONTEXT_AGENTS,
	getContextWindowForAgent,
	resilienceEnabled,
} from '../../shared/agentConstants';
import type { AgentCapabilitiesSnapshot } from '../../shared/agentCapabilities';
import { AGENT_IDS } from '../../shared/agentIds';

describe('agentConstants', () => {
	describe('FALLBACK_CONTEXT_WINDOW', () => {
		it('should be 200000', () => {
			expect(FALLBACK_CONTEXT_WINDOW).toBe(200000);
		});

		it('should be a positive number', () => {
			expect(FALLBACK_CONTEXT_WINDOW).toBeGreaterThan(0);
		});
	});

	describe('DEFAULT_CONTEXT_WINDOWS', () => {
		it('should have entries for active agents', () => {
			expect(DEFAULT_CONTEXT_WINDOWS['claude-code']).toBe(200000);
			expect(DEFAULT_CONTEXT_WINDOWS['codex']).toBe(200000);
			expect(DEFAULT_CONTEXT_WINDOWS['opencode']).toBe(128000);
			expect(DEFAULT_CONTEXT_WINDOWS['factory-droid']).toBe(200000);
			expect(DEFAULT_CONTEXT_WINDOWS['hermes']).toBe(200000);
			expect(DEFAULT_CONTEXT_WINDOWS['pi']).toBe(200000);
		});

		it('should have terminal context window set to 0', () => {
			expect(DEFAULT_CONTEXT_WINDOWS['terminal']).toBe(0);
		});

		it('keeps Grok explicitly unknown instead of assigning a speculative window', () => {
			expect(DEFAULT_CONTEXT_WINDOWS['grok']).toBe(0);
			expect(getContextWindowForAgent('grok')).toBe(0);
		});

		it('should only contain valid agent IDs', () => {
			for (const key of Object.keys(DEFAULT_CONTEXT_WINDOWS)) {
				expect(AGENT_IDS).toContain(key);
			}
		});

		it('should have positive defaults except for terminal and unknown Grok context', () => {
			for (const [key, value] of Object.entries(DEFAULT_CONTEXT_WINDOWS)) {
				if (key === 'terminal' || key === 'grok') {
					expect(value).toBe(0);
				} else {
					expect(value).toBeGreaterThan(0);
				}
			}
		});
	});

	describe('getContextWindowForAgent', () => {
		describe.each([
			{ host: 'local', remoteId: undefined },
			{ host: 'SSH', remoteId: 'remote-grok-test' },
		])('Grok with a $host snapshot', ({ remoteId }) => {
			it.each([200000, 500000, 1048576])(
				'ignores an unscoped cached window of %s even with model/version metadata',
				(contextWindow) => {
					const snapshot: AgentCapabilitiesSnapshot = {
						status: 'ok',
						path: '/synthetic/bin/grok',
						version: '1.0.70',
						models: ['grok-4.5', 'grok-composer-2.5-fast'],
						contextWindow,
						lastProbedAt: 1,
						remoteId,
					};

					// Neither a stale cache nor a new probe identifies the selected account/model.
					expect(getContextWindowForAgent('grok', snapshot)).toBe(0);
					expect(getContextWindowForAgent('grok', { ...snapshot, lastProbedAt: Date.now() })).toBe(
						0
					);
				}
			);

			it.each([undefined, 0, -1, NaN])(
				'keeps an absent or invalid window (%s) unknown instead of using the generic fallback',
				(contextWindow) => {
					expect(
						getContextWindowForAgent('grok', {
							status: 'ok',
							contextWindow,
							lastProbedAt: 1,
							remoteId,
						})
					).toBe(0);
				}
			);
		});

		// A Grok window is scoped to the selected account and model.
		describe('Grok account/model-scoped windows', () => {
			const snapshot: AgentCapabilitiesSnapshot = {
				status: 'ok',
				contextWindow: 999999,
				accountModelContextWindows: {
					'/synthetic/home/.grok': {
						windows: { 'grok-4.5': 256000, 'grok-4.7': 500000 },
						defaultModel: 'grok-4.7',
					},
					'/synthetic/other/.grok': { windows: { 'grok-4.5': 128000 } },
				},
				lastProbedAt: 1,
			};
			const account = '/synthetic/home/.grok';

			it('returns the captured window only for the matching account and model', () => {
				expect(
					getContextWindowForAgent('grok', snapshot, { model: 'grok-4.5', accountKey: account })
				).toBe(256000);
				expect(
					getContextWindowForAgent('grok', snapshot, {
						model: ' grok-4.5 ',
						accountKey: '/synthetic/other/.grok',
					})
				).toBe(128000);
			});

			it('falls back to the observed default model when the agent names none', () => {
				for (const model of [undefined, null, '', '  ']) {
					expect(getContextWindowForAgent('grok', snapshot, { model, accountKey: account })).toBe(
						500000
					);
				}
				expect(
					getContextWindowForAgent('grok', snapshot, {
						model: null,
						accountKey: '/synthetic/other/.grok',
					})
				).toBe(0);
			});

			it.each([
				['no selection', undefined],
				['an uncached model', { model: 'grok-4.6', accountKey: account }],
				['another account', { model: 'grok-4.5', accountKey: '/synthetic/third/.grok' }],
				['no account key', { model: 'grok-4.5', accountKey: null }],
				['an inherited model key', { model: 'toString', accountKey: account }],
				['an inherited account key', { model: 'grok-4.5', accountKey: 'constructor' }],
			])('returns 0 for %s', (_label, selection) => {
				expect(getContextWindowForAgent('grok', snapshot, selection)).toBe(0);
			});

			it.each([0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 2])(
				'returns 0 for an invalid captured window of %s',
				(window) => {
					expect(
						getContextWindowForAgent(
							'grok',
							{ status: 'ok', accountModelContextWindows: { a: { windows: { m: window } } } },
							{ model: 'm', accountKey: 'a' }
						)
					).toBe(0);
				}
			);

			it('never reads the scoped table for another provider', () => {
				expect(
					getContextWindowForAgent(
						'codex',
						{ status: 'ok', accountModelContextWindows: snapshot.accountModelContextWindows },
						{ model: 'grok-4.5', accountKey: account }
					)
				).toBe(200000);
			});
		});

		it.each([
			['claude-code', 200000],
			['codex', 200000],
			['opencode', 128000],
			['antigravity', 1048576],
			['terminal', 0],
			['unregistered-provider', FALLBACK_CONTEXT_WINDOW],
		] as const)('preserves the default for %s without a snapshot', (agentId, expected) => {
			expect(getContextWindowForAgent(agentId)).toBe(expected);
		});

		it.each(['claude-code', 'codex', 'opencode', 'antigravity', 'unregistered-provider'])(
			'prefers a positive snapshot over the default for %s',
			(agentId) => {
				expect(
					getContextWindowForAgent(agentId, {
						status: 'ok',
						contextWindow: 64000,
						lastProbedAt: 1,
					})
				).toBe(64000);
			}
		);

		it.each([undefined, 0, -1, NaN])(
			'preserves table and generic fallbacks for other providers with an invalid snapshot (%s)',
			(contextWindow) => {
				const snapshot: AgentCapabilitiesSnapshot = {
					status: 'ok',
					contextWindow,
					lastProbedAt: 1,
				};

				expect(getContextWindowForAgent('opencode', snapshot)).toBe(128000);
				expect(getContextWindowForAgent('terminal', snapshot)).toBe(0);
				expect(getContextWindowForAgent('unregistered-provider', snapshot)).toBe(
					FALLBACK_CONTEXT_WINDOW
				);
			}
		);
	});

	describe('COMBINED_CONTEXT_AGENTS', () => {
		it('should be a ReadonlySet', () => {
			expect(COMBINED_CONTEXT_AGENTS).toBeInstanceOf(Set);
		});

		it('should contain codex (OpenAI uses combined context)', () => {
			expect(COMBINED_CONTEXT_AGENTS.has('codex')).toBe(true);
		});

		it('should contain copilot-cli (Copilot CLI normalizes input reporting cumulative-style)', () => {
			expect(COMBINED_CONTEXT_AGENTS.has('copilot-cli')).toBe(true);
		});

		it('should not contain claude-code (Claude uses separate limits)', () => {
			expect(COMBINED_CONTEXT_AGENTS.has('claude-code')).toBe(false);
		});

		it('should only contain valid agent IDs', () => {
			for (const id of COMBINED_CONTEXT_AGENTS) {
				expect(AGENT_IDS).toContain(id);
			}
		});
	});

	describe('resilienceEnabled', () => {
		it('treats undefined as ON (read-time default, no migration for existing agents)', () => {
			expect(resilienceEnabled(undefined)).toBe(true);
		});

		it('treats an explicit true as ON', () => {
			expect(resilienceEnabled(true)).toBe(true);
		});

		it('only an explicit false opts out', () => {
			expect(resilienceEnabled(false)).toBe(false);
		});
	});
});
