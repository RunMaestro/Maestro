/**
 * Tests for the turn settings codified at send.
 *
 * Settings are codified when the user hits send (or queues): a turn runs, and
 * is labeled, with the provider, model, and effort in force at that moment,
 * whatever the user changes while it waits or works.
 *
 * The provider swap these used to sit beside moved to maestro-lib, and its
 * tests with it (`src/__tests__/shared/maestro-lib/agents/providerSwap.test.ts`).
 * This file only checks that the renderer's import site still reaches it.
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
	switchAgentProvider,
	switchTabProvider,
	switchTabProviderFor,
	resolveTabProvider,
	resolveTurnProvider,
	updateProviderSlot,
	codifyTurnSettings,
	captureQueuedTurnSettings,
	codifyQueuedTurnSettings,
	turnRunOnLabel,
	turnRunOnSource,
	tabSessionLaunch,
	settleAutoTurnOnTab,
	autoTurnLaunch,
	queuedTurnPills,
} from '../../../renderer/utils/providerTabSessions';
import { promptCacheLifetimeMs, type AutoRouteStamp } from '../../../shared/autoTurn';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { switchTabProvider as translationSwitch } from '../../../shared/maestro-lib/translation/session';
import * as providerSwap from '../../../shared/maestro-lib/agents/providerSwap';
import type { AITab, Session } from '../../../renderer/types';
import type { ToolType } from '../../../shared/types';

function makeTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 0,
		state: 'idle',
		...overrides,
	} as AITab;
}

function makeSession(toolType: ToolType, overrides: Partial<Session> = {}): Session {
	return { id: 'session-1', toolType, ...overrides } as Session;
}

describe('provider swap re-exports', () => {
	it('are the library implementation, so renderer turn attribution and runtime parking cannot drift', () => {
		expect(switchAgentProvider).toBe(providerSwap.switchAgentProvider);
		expect(switchTabProvider).toBe(providerSwap.switchTabProvider);
		expect(switchTabProviderFor).toBe(providerSwap.switchTabProviderFor);
		expect(resolveTabProvider).toBe(providerSwap.resolveTabProvider);
		expect(switchTabProvider).toBe(translationSwitch);
		expect(resolveTurnProvider).toBe(providerSwap.resolveTurnProvider);
		expect(updateProviderSlot).toBe(providerSwap.updateProviderSlot);
	});

	it('parks an agent provider without dropping a tab', () => {
		const session = makeSession('claude-code', {
			customModel: 'opus',
			aiTabs: [makeTab({ agentSessionId: 'claude-abc' }), makeTab({ id: 'tab-2' })],
		});

		const { agent } = switchAgentProvider(session, 'codex');

		expect(agent.toolType).toBe('codex');
		expect(agent.aiTabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2']);
		expect(agent.aiTabs[0].providerSessions?.['claude-code']?.agentSessionId).toBe('claude-abc');
		expect(agent.providerOverrides?.['claude-code']).toEqual({ customModel: 'opus' });
	});
});

describe('codifyTurnSettings', () => {
	it('freezes the provider, model, and effort a turn is sent with', () => {
		const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });
		const session = makeSession('claude-code', { customModel: 'sonnet', customEffort: 'low' });

		expect(codifyTurnSettings(tab, session)).toEqual({
			turnRunOnTarget: { type: 'provider' },
			turnProvider: 'claude-code',
			turnModel: 'opus',
			turnEffort: 'xhigh',
		});
	});

	it('falls back to the agent-level overrides when the tab has none', () => {
		const session = makeSession('codex', { customModel: 'gpt-5', customEffort: 'medium' });

		expect(codifyTurnSettings(makeTab(), session)).toEqual({
			turnRunOnTarget: { type: 'provider' },
			turnProvider: 'codex',
			turnModel: 'gpt-5',
			turnEffort: 'medium',
		});
	});

	it('leaves model and effort undefined when the agent default applies', () => {
		// Undefined is meaningful: consumers render no pill rather than labeling
		// the turn with a model name nobody chose.
		expect(codifyTurnSettings(makeTab(), makeSession('claude-code'))).toEqual({
			turnRunOnTarget: { type: 'provider' },
			turnProvider: 'claude-code',
			turnModel: undefined,
			turnEffort: undefined,
		});
	});
});

describe('captureQueuedTurnSettings', () => {
	it('freezes the model and effort in force when the item is queued', () => {
		const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });
		const session = makeSession('claude-code', { customModel: 'sonnet', customEffort: 'low' });

		expect(captureQueuedTurnSettings(tab, session)).toEqual({
			runOn: { type: 'provider' },
			routing: { harnessDefaults: useSettingsStore.getState().harnessTierDefaults },
			provider: 'claude-code',
			model: 'opus',
			effort: 'xhigh',
		});
	});

	it('captures the agent default as an explicit pair of undefined fields', () => {
		// The OBJECT is the capture flag, so it must exist even when both values
		// are the agent's own default - otherwise dispatch falls back to the live
		// values and the item inherits a model the user picked afterwards.
		const captured = captureQueuedTurnSettings(makeTab(), makeSession('codex'));

		expect(captured).toEqual({
			provider: 'codex',
			model: undefined,
			effort: undefined,
			runOn: { type: 'provider' },
			routing: { harnessDefaults: useSettingsStore.getState().harnessTierDefaults },
		});
	});
});

describe('codifyQueuedTurnSettings', () => {
	it('keeps the captured provider when agent defaults changed', () => {
		const item = {
			turnSettings: { provider: 'claude-code' as const, model: 'opus', effort: 'high' },
		};
		expect(codifyQueuedTurnSettings(item, makeTab(), makeSession('codex'))).toMatchObject({
			turnProvider: 'claude-code',
			turnModel: 'opus',
			turnEffort: 'high',
		});
	});
	it('uses destination settings for migrated queued items while keeping their saved settings intact', () => {
		const item = { id: 'queued', turnSettings: { model: 'haiku', effort: 'low' } };
		const session = makeSession('codex', {
			providerTranslationQueuedOrigins: { queued: 'claude-code' },
			customModel: 'gpt-6',
			customEffort: 'high',
		});
		expect(codifyQueuedTurnSettings(item, undefined, session)).toEqual({
			turnRunOnTarget: { type: 'provider' },
			turnProvider: 'codex',
			turnModel: 'gpt-6',
			turnEffort: 'high',
		});
		expect(item.turnSettings.model).toBe('haiku');
	});
	it('runs a queued item under what it was queued with, not the live values', () => {
		const item = { turnSettings: { model: 'haiku', effort: 'low' } };
		// The user has since switched the tab to a big model.
		const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });
		const session = makeSession('claude-code');

		expect(codifyQueuedTurnSettings(item, tab, session)).toEqual({
			turnRunOnTarget: { type: 'provider' },
			turnProvider: 'claude-code',
			turnModel: 'haiku',
			turnEffort: 'low',
		});
	});

	it('keeps an item queued on the agent default on the default', () => {
		const item = { turnSettings: {} };
		const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });

		expect(codifyQueuedTurnSettings(item, tab, makeSession('claude-code'))).toEqual({
			turnRunOnTarget: { type: 'provider' },
			turnProvider: 'claude-code',
			turnModel: undefined,
			turnEffort: undefined,
		});
	});

	it('falls back to the live values for items queued before capture existed', () => {
		const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });

		expect(codifyQueuedTurnSettings({}, tab, makeSession('claude-code'))).toEqual({
			turnRunOnTarget: { type: 'provider' },
			turnProvider: 'claude-code',
			turnModel: 'opus',
			turnEffort: 'xhigh',
		});
	});

	it('always spawns on the live provider, which owns the resume token', () => {
		const item = { turnSettings: { model: 'haiku', effort: 'low' } };

		expect(codifyQueuedTurnSettings(item, makeTab(), makeSession('codex')).turnProvider).toBe(
			'codex'
		);
	});

	it('honors an override the user set while EDITING the queued message', () => {
		// The queued item was captured on haiku/low, then the user opened the
		// edit modal and switched it to opus/xhigh. The edit rewrites
		// turnSettings, so dispatch must spawn on the edited values - not the
		// original capture, and not the tab's live selection either.
		const edited = { turnSettings: { model: 'opus', effort: 'xhigh' } };
		const tab = makeTab({ customModel: 'sonnet', customEffort: 'medium' });

		expect(codifyQueuedTurnSettings(edited, tab, makeSession('claude-code'))).toEqual({
			turnRunOnTarget: { type: 'provider' },
			turnProvider: 'claude-code',
			turnModel: 'opus',
			turnEffort: 'xhigh',
		});
	});

	it('sends an edited-back-to-default message on the agent default', () => {
		// Clearing a picker in the edit modal drops the field. That must mean
		// "use the agent default", not "fall back to the tab's current model".
		const cleared = { turnSettings: { effort: 'xhigh' } };
		const tab = makeTab({ customModel: 'sonnet', customEffort: 'medium' });

		expect(codifyQueuedTurnSettings(cleared, tab, makeSession('claude-code'))).toEqual({
			turnRunOnTarget: { type: 'provider' },
			turnProvider: 'claude-code',
			turnModel: undefined,
			turnEffort: 'xhigh',
		});
	});
});

describe('turnRunOn: where a Run on turn ran', () => {
	const OLLAMA = {
		id: 'ep-ollama',
		name: 'Ollama',
		kind: 'ollama' as const,
		baseUrl: 'http://127.0.0.1:11434',
		enabled: true,
	};
	const QWEN = { type: 'source' as const, endpointId: OLLAMA.id, model: 'qwen3:latest' };

	it('names nothing for an agent on its provider', () => {
		expect(turnRunOnLabel({})).toBeUndefined();
		expect(turnRunOnLabel({ runOn: { type: 'provider' } })).toBeUndefined();
		expect(codifyTurnSettings(makeTab(), makeSession('claude-code')).turnRunOn).toBeUndefined();
	});

	it('names the model and the source for an agent on a source', () => {
		expect(turnRunOnLabel({ runOn: QWEN }, [OLLAMA])).toBe('qwen3:latest · Ollama');
	});

	it('reads the saved sources when it is handed none', () => {
		const saved = useSettingsStore.getState().localModelEndpoints;
		useSettingsStore.setState({ localModelEndpoints: [OLLAMA] });
		try {
			expect(turnRunOnLabel({ runOn: QWEN })).toBe('qwen3:latest · Ollama');
		} finally {
			useSettingsStore.setState({ localModelEndpoints: saved });
		}
	});

	it('names nothing for a stored target that cannot be read: its launch is refused', () => {
		expect(
			turnRunOnLabel({ runOn: { type: 'source', endpointId: OLLAMA.id } as never }, [OLLAMA])
		).toBeUndefined();
	});

	it('stamps the label beside the model, which stays what the spawn is handed', () => {
		const session = makeSession('claude-code', { customModel: 'opus', runOn: QWEN });

		expect(codifyTurnSettings(makeTab(), session)).toMatchObject({
			turnModel: 'opus',
			turnRunOn: 'qwen3:latest',
		});
	});

	it('reads the label live for a queued item: the launch reads the target when it spawns', () => {
		const item = { turnSettings: { model: 'haiku', effort: 'low' } };
		const session = makeSession('claude-code', { runOn: QWEN });

		expect(codifyQueuedTurnSettings(item, makeTab(), session)).toMatchObject({
			turnModel: 'haiku',
			turnRunOn: 'qwen3:latest',
		});
		expect(
			codifyQueuedTurnSettings(item, makeTab(), makeSession('claude-code')).turnRunOn
		).toBeUndefined();
	});

	describe('turnRunOnSource: the source behind the label, for the stats row', () => {
		it('is the target itself for an agent on a source, and nothing on its provider', () => {
			expect(turnRunOnSource({ runOn: QWEN })).toEqual(QWEN);
			expect(turnRunOnSource({})).toBeUndefined();
			expect(turnRunOnSource({ runOn: { type: 'provider' } })).toBeUndefined();
		});

		it('is nothing for a stored target that cannot be read: no turn runs on it', () => {
			expect(
				turnRunOnSource({ runOn: { type: 'source', endpointId: OLLAMA.id } as never })
			).toBeUndefined();
		});

		it('is frozen at send beside the label, so the two can never name different places', () => {
			const session = makeSession('claude-code', { customModel: 'opus', runOn: QWEN });

			const codified = codifyTurnSettings(makeTab(), session);

			expect(codified.turnRunOnSource).toEqual(QWEN);
			expect(codified.turnRunOn).toBe('qwen3:latest');
		});

		it('is cleared by a turn on the provider, so the turn before it does not leak through', () => {
			// A tab patch spreads these fields over the tab: a key that is absent
			// would leave the last turn's source in place.
			const ranOnSource = { ...makeTab(), turnRunOn: 'qwen3:latest', turnRunOnSource: QWEN };

			const next = {
				...ranOnSource,
				...codifyTurnSettings(ranOnSource, makeSession('claude-code')),
			};

			expect(next.turnRunOnSource).toBeUndefined();
			expect(next.turnRunOn).toBeUndefined();
		});

		it('is read when a queued item takes the tab, like the label', () => {
			const item = { turnSettings: { model: 'haiku', effort: 'low' } };

			expect(
				codifyQueuedTurnSettings(item, makeTab(), makeSession('claude-code', { runOn: QWEN }))
					.turnRunOnSource
			).toEqual(QWEN);
			expect(
				codifyQueuedTurnSettings(item, makeTab(), makeSession('claude-code')).turnRunOnSource
			).toBeUndefined();
		});

		it("is the agent's own source for a turn on Auto that chose no place", () => {
			const session = makeSession('claude-code', { customModel: 'auto', runOn: QWEN });

			expect(codifyTurnSettings(makeTab(), session).turnRunOnSource).toEqual(QWEN);
		});
	});
});

describe('a turn sent on the Auto model', () => {
	const OLLAMA = {
		id: 'ep-ollama',
		name: 'Ollama',
		kind: 'ollama' as const,
		baseUrl: 'http://127.0.0.1:11434',
		enabled: true,
	};
	const QWEN = { type: 'source' as const, endpointId: OLLAMA.id, model: 'qwen3:latest' };

	const route = (
		tier: 'low' | 'medium' | 'high',
		effort: 'low' | 'medium' | 'high'
	): AutoRouteStamp => ({ tier, effort, engine: 'Embedding router', calibrated: false });
	const OFF: AutoRouteStamp = { skipped: 'off', detail: 'Model routing is off.' };

	/** A tab whose provider session last answered `idleMs` ago, on `turnModel`. */
	const liveTab = (idleMs: number, overrides: Partial<AITab> = {}): AITab =>
		makeTab({
			agentSessionId: 'claude-abc',
			turnProvider: 'claude-code',
			turnModel: 'haiku',
			logs: [{ id: 'l1', timestamp: Date.now() - idleMs, source: 'stdout', text: 'done' }] as any,
			...overrides,
		});
	const AUTO = makeSession('claude-code', { customModel: 'auto', customEffort: 'high' });
	const COLD = promptCacheLifetimeMs('claude-code') + 60_000;

	describe('tabSessionLaunch: what the session a turn would resume last ran on', () => {
		it('is nothing for a tab with no provider session: the turn starts one', () => {
			expect(tabSessionLaunch(makeTab({ turnModel: 'opus' }), AUTO)).toBeUndefined();
			expect(tabSessionLaunch(undefined, AUTO)).toBeUndefined();
		});

		it('is the last turn model, the place a tier sent it, and the newest entry time', () => {
			const tab = liveTab(1000, { turnAuto: { status: 'routed', runOn: QWEN } });
			expect(tabSessionLaunch(tab, AUTO)).toEqual({
				model: 'haiku',
				runOn: QWEN,
				lastActiveAt: tab.logs[0].timestamp,
			});
		});

		it('counts a busy tab as active now', () => {
			const tab = liveTab(COLD, { state: 'busy' });
			expect(tabSessionLaunch(tab, AUTO, 5000)?.lastActiveAt).toBe(5000);
		});

		it('is nothing when the last turn ran under another provider', () => {
			expect(tabSessionLaunch(liveTab(1000, { turnProvider: 'codex' }), AUTO)).toBeUndefined();
		});

		it('has no last activity for a session with an empty transcript, which reads as cold', () => {
			const launch = tabSessionLaunch(liveTab(0, { logs: [] }), AUTO);
			expect(launch).toEqual({ model: 'haiku' });
		});
	});

	describe('codifyTurnSettings: the turn takes the tab before the router answers', () => {
		it('never freezes the word auto as the model, and marks the turn pending', () => {
			expect(codifyTurnSettings(makeTab(), AUTO)).toEqual({
				turnRunOnTarget: { type: 'provider' },
				turnProvider: 'claude-code',
				turnModel: undefined,
				turnEffort: 'high',
				turnRunOn: undefined,
				turnAuto: { status: 'pending' },
				turnRouting: { harnessDefaults: useSettingsStore.getState().harnessTierDefaults },
			});
		});

		it('reads the tab override first, like any model choice', () => {
			const session = makeSession('claude-code', { customModel: 'opus' });
			expect(codifyTurnSettings(makeTab({ customModel: 'auto' }), session).turnAuto).toEqual({
				status: 'pending',
			});
			expect(codifyTurnSettings(makeTab({ customModel: 'opus' }), AUTO).turnAuto).toBeUndefined();
		});

		it('rule 1: holds the model of a session whose cache is warm', () => {
			expect(codifyTurnSettings(liveTab(30_000), AUTO)).toMatchObject({
				turnModel: 'haiku',
				turnEffort: 'high',
				turnAuto: { status: 'pending', hold: { model: 'haiku' } },
			});
		});

		it('rule 1: holds the place a tier sent the session, and labels it', () => {
			const saved = useSettingsStore.getState().localModelEndpoints;
			useSettingsStore.setState({ localModelEndpoints: [OLLAMA] });
			try {
				const tab = liveTab(30_000, {
					turnModel: 'qwen3:latest',
					turnAuto: { status: 'routed', runOn: QWEN },
				});
				expect(codifyTurnSettings(tab, AUTO)).toMatchObject({
					turnModel: 'qwen3:latest',
					turnRunOn: 'qwen3:latest · Ollama',
					turnRunOnSource: QWEN,
					turnAuto: {
						status: 'pending',
						hold: { model: 'qwen3:latest', runOn: QWEN },
						runOn: QWEN,
					},
				});
			} finally {
				useSettingsStore.setState({ localModelEndpoints: saved });
			}
		});

		it('rule 1: holds nothing once the session has been idle past the cache lifetime', () => {
			expect(codifyTurnSettings(liveTab(COLD), AUTO)).toMatchObject({
				turnModel: undefined,
				turnAuto: { status: 'pending' },
				turnRouting: { harnessDefaults: useSettingsStore.getState().harnessTierDefaults },
			});
			expect(codifyTurnSettings(liveTab(COLD), AUTO).turnAuto?.hold).toBeUndefined();
		});

		it('a turn on a named model clears the stamp the Auto turn before it left', () => {
			const tab = liveTab(1000, { turnAuto: { status: 'routed', runOn: QWEN } });
			const codified = codifyTurnSettings(tab, makeSession('claude-code', { customModel: 'opus' }));
			expect('turnAuto' in codified).toBe(true);
			expect({ ...tab, ...codified }.turnAuto).toBeUndefined();
		});

		it('with the answer in hand the stamp is final at once', () => {
			expect(codifyTurnSettings(makeTab(), AUTO, route('medium', 'low'))).toEqual({
				turnRunOnTarget: { type: 'provider' },
				turnProvider: 'claude-code',
				turnModel: 'sonnet',
				turnEffort: 'low',
				turnRunOn: undefined,
				turnAuto: { status: 'routed', route: route('medium', 'low') },
				turnRouting: { harnessDefaults: useSettingsStore.getState().harnessTierDefaults },
			});
		});
	});

	describe('settleAutoTurnOnTab: the router answered', () => {
		const pending = (tab: AITab): AITab => ({ ...tab, ...codifyTurnSettings(tab, AUTO) });

		it('a session start takes the tier and the effort', () => {
			const settled = settleAutoTurnOnTab(pending(makeTab()), AUTO, route('high', 'low'));
			expect(settled).toMatchObject({
				turnModel: 'opus',
				turnEffort: 'low',
				turnAuto: { status: 'routed', route: route('high', 'low') },
			});
			expect(settled.turnAuto?.hold).toBeUndefined();
		});

		it('rule 1: a warm session keeps its model and changes only its effort', () => {
			const settled = settleAutoTurnOnTab(pending(liveTab(30_000)), AUTO, route('high', 'low'));
			expect(settled).toMatchObject({
				turnModel: 'haiku',
				turnEffort: 'low',
				turnAuto: { status: 'routed', hold: { model: 'haiku' } },
			});
		});

		it('rule 1 is decided when the turn took the tab, not when the answer lands', () => {
			// The busy-write appends the user bubble and marks the tab busy, which
			// would make a cold session look warm to anything that looked again.
			const cold = pending(liveTab(COLD));
			const busy: AITab = {
				...cold,
				state: 'busy',
				logs: [...cold.logs, { id: 'u', timestamp: Date.now(), source: 'user', text: 'go' }] as any,
			};
			expect(settleAutoTurnOnTab(busy, AUTO, route('high', 'low')).turnModel).toBe('opus');
		});

		it('rule 2: no decision leaves the agent default, and its own effort', () => {
			const settled = settleAutoTurnOnTab(pending(makeTab()), AUTO, OFF);
			expect(settled).toMatchObject({
				turnModel: undefined,
				turnEffort: 'high',
				turnAuto: { status: 'router-off', route: OFF },
			});
		});

		it('launches a tier the agent maps to a source on that source', () => {
			const saved = useSettingsStore.getState().localModelEndpoints;
			useSettingsStore.setState({ localModelEndpoints: [OLLAMA] });
			try {
				const session = makeSession('claude-code', {
					customModel: 'auto',
					tierTargets: { low: QWEN },
				});
				const tab = { ...makeTab(), ...codifyTurnSettings(makeTab(), session) };
				const settled = settleAutoTurnOnTab(tab, session, route('low', 'low'));
				expect(settled).toMatchObject({
					turnModel: 'qwen3:latest',
					turnRunOn: 'qwen3:latest · Ollama',
					// The place the router's tier chose, which the stats row names.
					turnRunOnSource: QWEN,
					turnAuto: { status: 'routed', runOn: QWEN },
				});
				expect(autoTurnLaunch(settled)).toEqual({
					model: 'qwen3:latest',
					effort: 'low',
					runOn: QWEN,
					route: route('low', 'low'),
				});
			} finally {
				useSettingsStore.setState({ localModelEndpoints: saved });
			}
		});

		it('leaves a turn that is not pending alone: a late answer rewrites nothing', () => {
			const settled = settleAutoTurnOnTab(pending(makeTab()), AUTO, route('high', 'low'));
			expect(settleAutoTurnOnTab(settled, AUTO, route('low', 'high'))).toBe(settled);
			const named = makeTab({ turnModel: 'opus' });
			expect(settleAutoTurnOnTab(named, AUTO, route('low', 'high'))).toBe(named);
		});
	});

	describe('autoTurnLaunch: what the spawn is handed', () => {
		it('is nothing for a turn on a named model, and for one still pending', () => {
			expect(autoTurnLaunch(makeTab({ turnModel: 'opus' }))).toBeNull();
			expect(autoTurnLaunch(makeTab({ turnAuto: { status: 'pending' } }))).toBeNull();
			expect(autoTurnLaunch(undefined)).toBeNull();
		});

		it('is the frozen model and effort, with no place when Auto decided none', () => {
			const tab = makeTab({
				turnModel: 'sonnet',
				turnEffort: 'low',
				turnAuto: { status: 'routed', route: route('medium', 'low') },
				turnRouting: { harnessDefaults: useSettingsStore.getState().harnessTierDefaults },
			});
			expect(autoTurnLaunch(tab)).toEqual({
				model: 'sonnet',
				effort: 'low',
				route: route('medium', 'low'),
			});
		});

		it('is empty for a turn with no decision: the agent default launches', () => {
			expect(autoTurnLaunch(makeTab({ turnAuto: { status: 'no-decision' } }))).toEqual({});
		});
	});

	describe('a queued item', () => {
		it('keeps the word, and the answer when the caller has one', () => {
			expect(captureQueuedTurnSettings(makeTab(), AUTO)).toEqual({
				runOn: { type: 'provider' },
				routing: { harnessDefaults: useSettingsStore.getState().harnessTierDefaults },
				provider: 'claude-code',
				model: 'auto',
				effort: 'high',
			});
			expect(captureQueuedTurnSettings(makeTab(), AUTO, route('low', 'low'))).toEqual({
				runOn: { type: 'provider' },
				routing: { harnessDefaults: useSettingsStore.getState().harnessTierDefaults },
				provider: 'claude-code',
				model: 'auto',
				effort: 'high',
				route: route('low', 'low'),
			});
		});

		it('carries no answer on a named model', () => {
			const session = makeSession('claude-code', { customModel: 'opus' });
			expect(captureQueuedTurnSettings(makeTab(), session, route('low', 'low'))).toEqual({
				runOn: { type: 'provider' },
				routing: { harnessDefaults: useSettingsStore.getState().harnessTierDefaults },
				provider: 'claude-code',
				model: 'opus',
				effort: undefined,
			});
		});

		it('routed when it was queued: final the moment it takes the tab, on its own effort', () => {
			const item = {
				turnSettings: { model: 'auto', effort: 'low', route: route('high', 'medium') },
			};
			// The agent has since moved to a named model. The item is still Auto.
			const session = makeSession('claude-code', { customModel: 'sonnet', customEffort: 'max' });
			expect(codifyQueuedTurnSettings(item, makeTab(), session)).toEqual({
				turnRunOnTarget: { type: 'provider' },
				turnProvider: 'claude-code',
				turnModel: 'opus',
				turnEffort: 'high',
				turnRunOn: undefined,
				turnAuto: { status: 'routed', route: route('high', 'medium') },
				turnRouting: { harnessDefaults: useSettingsStore.getState().harnessTierDefaults },
			});
		});

		it('rule 1 is read from the tab when the item drains, not when it was queued', () => {
			const item = { turnSettings: { model: 'auto', route: route('high', 'medium') } };
			expect(codifyQueuedTurnSettings(item, liveTab(30_000), AUTO)).toMatchObject({
				turnModel: 'haiku',
				turnEffort: 'high',
				turnAuto: { status: 'routed', hold: { model: 'haiku' } },
			});
			expect(codifyQueuedTurnSettings(item, liveTab(COLD), AUTO).turnModel).toBe('opus');
		});

		it('not routed yet: pending, for the dispatch to settle', () => {
			const item = { turnSettings: { model: 'auto', effort: 'low' } };
			expect(codifyQueuedTurnSettings(item, makeTab(), AUTO)).toMatchObject({
				turnModel: undefined,
				turnEffort: 'low',
				turnAuto: { status: 'pending' },
				turnRouting: { harnessDefaults: useSettingsStore.getState().harnessTierDefaults },
			});
		});

		it('queued on a named model stays on it when the agent is set to Auto afterwards', () => {
			const item = { turnSettings: { model: 'haiku', effort: 'low' } };
			const codified = codifyQueuedTurnSettings(item, makeTab(), AUTO);
			expect(codified).toMatchObject({ turnModel: 'haiku', turnEffort: 'low' });
			expect(codified.turnAuto).toBeUndefined();
		});

		it('from before settings were captured follows the agent, Auto included', () => {
			expect(codifyQueuedTurnSettings({}, makeTab(), AUTO).turnAuto).toEqual({ status: 'pending' });
		});
	});

	describe('queuedTurnPills: what a queued item reads while it waits', () => {
		it('is nothing for an item with no captured settings', () => {
			expect(queuedTurnPills(undefined)).toEqual({ model: undefined, effort: undefined });
		});

		it('passes a named model and its effort through, with no Auto stamp', () => {
			const pills = queuedTurnPills({ model: 'opus', effort: 'high' });
			expect(pills).toEqual({ model: 'opus', effort: 'high' });
			expect(pills.auto).toBeUndefined();
		});

		it('ignores an answer left on a named model', () => {
			const pills = queuedTurnPills({ model: 'opus', effort: 'high', route: route('low', 'low') });
			expect(pills).toEqual({ model: 'opus', effort: 'high' });
		});

		it('on Auto and not routed yet: pending, with the effort the tab was on', () => {
			expect(queuedTurnPills({ model: 'auto', effort: 'high' })).toEqual({
				auto: { status: 'pending' },
				effort: 'high',
			});
		});

		it('on Auto and routed: the answer, and no effort, because the router picks it', () => {
			const pills = queuedTurnPills({ model: 'auto', effort: 'high', route: route('low', 'low') });
			expect(pills).toEqual({ auto: { status: 'routed', route: route('low', 'low') } });
			expect('effort' in pills).toBe(false);
			// Never the word as a model: the Auto pill stands in for the model pill.
			expect(pills.model).toBeUndefined();
		});

		it('on Auto with the router off: says so, and keeps the effort the turn will run at', () => {
			const skipped: AutoRouteStamp = { skipped: 'off', detail: 'x' };
			expect(queuedTurnPills({ model: 'auto', effort: 'high', route: skipped })).toEqual({
				auto: { status: 'router-off', route: skipped },
				effort: 'high',
			});
		});

		it('reads the word in any spelling', () => {
			expect(queuedTurnPills({ model: 'Auto' }).auto).toEqual({ status: 'pending' });
		});
	});
});

describe('Ensemble turn captures', () => {
	let saved: ReturnType<typeof useSettingsStore.getState>;
	beforeEach(() => {
		saved = useSettingsStore.getState();
		useSettingsStore.setState({ harnessTierDefaults: {}, localModelEndpoints: [] });
	});
	afterEach(() => {
		useSettingsStore.setState({
			harnessTierDefaults: saved.harnessTierDefaults,
			localModelEndpoints: saved.localModelEndpoints,
		});
	});

	it('shows the queued provider and source after the tab selection and agent target change', () => {
		const session = makeSession('claude-code', {
			runOn: { type: 'source', endpointId: 'ollama', model: 'queued-model' },
		});
		const tab = makeTab({ customModel: 'sonnet', customEffort: 'high' });
		const settings = captureQueuedTurnSettings(tab, session);
		const switched = switchTabProviderFor(tab, session, 'codex');
		session.runOn = { type: 'provider' };
		expect(queuedTurnPills(settings)).toEqual({
			provider: 'claude-code',
			model: 'sonnet',
			effort: 'high',
			runOn: turnRunOnLabel({ runOn: settings.runOn }),
		});
		expect(codifyQueuedTurnSettings({ turnSettings: settings }, switched, session)).toMatchObject({
			turnProvider: 'claude-code',
			turnRunOnSource: { endpointId: 'ollama', model: 'queued-model' },
		});
	});

	it('uses frozen foreign-harness Auto tiers and Run on in both queue pills and dispatch', () => {
		useSettingsStore.setState({
			harnessTierDefaults: {
				codex: { high: { type: 'source', endpointId: 'frozen-source', model: 'frozen-model' } },
			},
		});
		const session = makeSession('claude-code', {
			tierTargets: { high: { type: 'provider-model', model: 'wrong-agent-tier' } },
			runOn: { type: 'source', endpointId: 'wrong-source', model: 'wrong-model' },
		});
		const tab = makeTab({ tabProvider: 'codex', customModel: 'auto' });
		const settings = captureQueuedTurnSettings(tab, session);
		settings.route = { tier: 'high', effort: 'high', engine: 'System One', calibrated: true };
		useSettingsStore.setState({
			harnessTierDefaults: { codex: { high: { type: 'provider-model', model: 'changed-tier' } } },
		});
		const captured = codifyQueuedTurnSettings({ turnSettings: settings }, tab, session);
		expect(settings.model).toBe('auto');
		expect(settings.routing?.tierTargets).toBeUndefined();
		expect(settings.runOn).toEqual({ type: 'provider' });
		expect(captured).toMatchObject({
			turnProvider: 'codex',
			turnModel: 'frozen-model',
			turnRunOnTarget: { type: 'source', endpointId: 'frozen-source', model: 'frozen-model' },
			turnRunOnSource: { endpointId: 'frozen-source', model: 'frozen-model' },
		});
		expect(queuedTurnPills(settings)).toMatchObject({
			provider: 'codex',
			runOn: captured.turnRunOn,
			auto: { status: 'routed', route: settings.route },
		});
	});

	it('lets a captured Auto provider tier replace a source and keeps source on no decision', () => {
		const session = makeSession('claude-code', {
			customModel: 'auto',
			tierTargets: { high: { type: 'provider-model', model: 'cloud-tier' } },
			runOn: { type: 'source', endpointId: 'ollama', model: 'source-model' },
		});
		const settings = captureQueuedTurnSettings(makeTab(), session);
		settings.route = { tier: 'high', effort: 'high', engine: 'System One', calibrated: true };
		expect(queuedTurnPills(settings).runOn).toBeUndefined();
		settings.route = { skipped: 'off', detail: 'Router off' };
		expect(queuedTurnPills(settings)).toMatchObject({
			provider: 'claude-code',
			runOn: turnRunOnLabel({ runOn: settings.runOn }),
			auto: { status: 'router-off' },
		});
	});

	it('freezes a tab pin and its provider defaults while the feature controls are hidden', () => {
		const session = makeSession('claude-code', {
			customModel: 'opus',
			customEffort: 'max',
			providerOverrides: { codex: { customModel: 'gpt-default', customEffort: 'high' } },
		});
		const tab = makeTab({ tabProvider: 'codex' });
		expect(codifyTurnSettings(tab, session)).toMatchObject({
			turnProvider: 'codex',
			turnModel: 'gpt-default',
			turnEffort: 'high',
			turnRunOnTarget: { type: 'provider' },
		});
	});

	it('keeps a queued provider and explicit cloud target after a selection and routing change', () => {
		const tab = makeTab({ customModel: 'opus', customEffort: 'high', runOn: { type: 'provider' } });
		const session = makeSession('claude-code');
		const turnSettings = captureQueuedTurnSettings(tab, session);
		const switched = switchTabProviderFor(tab, session, 'codex');
		// Later composer choices apply only to the next send, not this queued message.
		switched.customModel = 'gpt-next';
		switched.customEffort = 'low';
		expect(codifyTurnSettings(switched, session)).toMatchObject({
			turnProvider: 'codex',
			turnModel: 'gpt-next',
			turnEffort: 'low',
		});
		const result = codifyQueuedTurnSettings({ turnSettings }, switched, {
			...session,
			runOn: { type: 'source', endpointId: 'new-source', model: 'new-model' },
		});
		expect(result).toMatchObject({
			turnProvider: 'claude-code',
			turnModel: 'opus',
			turnEffort: 'high',
			turnRunOnTarget: { type: 'provider' },
		});
		expect(switched.tabProvider).toBe('codex');
	});

	it('does not reuse another provider cache and keeps Auto inside the pinned harness', () => {
		const session = makeSession('claude-code', {
			tierTargets: { high: { type: 'provider-model', model: 'opus' } },
		});
		const tab = makeTab({
			tabProvider: 'codex',
			customModel: 'auto',
			agentSessionId: 'codex-id',
			turnProvider: 'claude-code',
			turnModel: 'opus',
		});
		expect(tabSessionLaunch(tab, session)).toBeUndefined();
		const answer = {
			tier: 'high',
			effort: 'high',
			engine: 'Embedding router',
			calibrated: false,
		} satisfies AutoRouteStamp;
		const settings = codifyTurnSettings(tab, session, answer);
		expect(settings.turnProvider).toBe('codex');
		expect(settings.turnModel).not.toBe('opus');
		expect(settings.turnModel).not.toBe('auto');
	});
});

it('does not retain an Auto cache hold after native translation replaces the session', () => {
	const session = makeSession('claude-code', { customModel: 'auto' });
	const tab = makeTab({
		agentSessionId: 'translated-native',
		turnSessionId: 'original-native',
		turnProvider: 'claude-code',
		turnModel: 'opus',
	});
	expect(tabSessionLaunch(tab, session)).toBeUndefined();
});
