import type {
	SystemOneAgentAccess,
	SystemOneAgentGate,
} from '../../shared/local-models/system-one-agent';

/**
 * What `getSystemOneAgentAccess()` answers for an agent whose request would be
 * answered: the hosted Jev, tested, agent use on, a dollar a day with nothing
 * spent. Tests of the system prompt builders pass overrides for the case they
 * are about.
 */
export function systemOneAccess(
	overrides: Partial<SystemOneAgentAccess> = {}
): SystemOneAgentAccess {
	return {
		allowed: true,
		gate: null,
		message: null,
		reason: null,
		engine: 'jev-cloud',
		engineLabel: 'Jev (TypeSafe cloud)',
		calibrated: true,
		budget: {
			dayStartedAt: 0,
			dailyBudgetUsd: 1,
			spentTodayUsd: 0,
			remainingTodayUsd: 1,
		},
		...overrides,
	};
}

/** The same engine, refused by one switch: what every gate but the engine being off looks like. */
export function refusedSystemOneAccess(gate: SystemOneAgentGate): SystemOneAgentAccess {
	return systemOneAccess({
		allowed: false,
		gate,
		message: `System One is off (${gate}). Continue without System One.`,
		reason: `System One is off (${gate}).`,
		...(gate === 'engine-off'
			? { engine: 'off' as const, engineLabel: 'Off', calibrated: null }
			: {}),
	});
}

/** Every switch that refuses an agent, in the order the service asks them. */
export const SYSTEM_ONE_GATES: readonly SystemOneAgentGate[] = [
	'engine-off',
	'agents-off',
	'agent-opted-out',
	'engine-not-ready',
	'engine-untested',
	'budget-day',
	'budget-agent',
];
