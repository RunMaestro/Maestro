import { describe, it, expect } from 'vitest';
import {
	CALLER_AGENT_ID_ENV_VAR,
	CALLER_TAB_ID_ENV_VAR,
	buildCallerIdentityEnv,
	callerMessageFields,
	isSelfDispatch,
	readCallerIdentity,
	readCallerMessageFields,
	withoutCallerIdentityEnv,
} from '../../shared/agentDelegation';

describe('caller identity env', () => {
	it('round-trips the agent and tab through the environment', () => {
		const env = buildCallerIdentityEnv('agent-1', 'tab-1');
		expect(env).toEqual({
			[CALLER_AGENT_ID_ENV_VAR]: 'agent-1',
			[CALLER_TAB_ID_ENV_VAR]: 'tab-1',
		});
		expect(readCallerIdentity(env)).toEqual({ agentId: 'agent-1', tabId: 'tab-1' });
	});

	it('omits the tab when the spawn had none', () => {
		const env = buildCallerIdentityEnv('agent-1');
		expect(env).not.toHaveProperty(CALLER_TAB_ID_ENV_VAR);
		expect(readCallerIdentity(env)).toEqual({ agentId: 'agent-1' });
	});

	it('treats a blank agent as no caller and drops a tab that has no agent', () => {
		expect(readCallerIdentity({})).toBeUndefined();
		expect(readCallerIdentity({ [CALLER_AGENT_ID_ENV_VAR]: '  ' })).toBeUndefined();
		expect(readCallerIdentity({ [CALLER_TAB_ID_ENV_VAR]: 'tab-1' })).toBeUndefined();
		expect(
			readCallerIdentity({ [CALLER_AGENT_ID_ENV_VAR]: 'agent-1', [CALLER_TAB_ID_ENV_VAR]: '' })
		).toEqual({ agentId: 'agent-1' });
	});

	it('never reuses MAESTRO_AGENT_ID, which tells a pianola watch it is Pianola', () => {
		expect(CALLER_AGENT_ID_ENV_VAR).not.toBe('MAESTRO_AGENT_ID');
	});
});

describe('withoutCallerIdentityEnv', () => {
	it('collapses an identity-only record to undefined, like an agent with no overrides', () => {
		expect(withoutCallerIdentityEnv(buildCallerIdentityEnv('agent-1', 'tab-1'))).toBeUndefined();
		expect(withoutCallerIdentityEnv(undefined)).toBeUndefined();
	});

	it('keeps real configuration and leaves the input untouched', () => {
		const env = { ...buildCallerIdentityEnv('agent-1'), CLAUDE_CONFIG_DIR: '/cfg' };
		expect(withoutCallerIdentityEnv(env)).toEqual({ CLAUDE_CONFIG_DIR: '/cfg' });
		expect(env).toHaveProperty(CALLER_AGENT_ID_ENV_VAR, 'agent-1');
	});
});

describe('caller wire fields', () => {
	it('spreads nothing when there is no caller', () => {
		expect(callerMessageFields(undefined)).toEqual({});
	});

	it('round-trips a caller through a message', () => {
		const fields = callerMessageFields({ agentId: 'agent-1', tabId: 'tab-1' });
		expect(fields).toEqual({ fromSessionId: 'agent-1', fromTabId: 'tab-1' });
		expect(readCallerMessageFields({ type: 'send_command', ...fields })).toEqual(fields);
	});

	it('rejects blank and non-string fields from an untrusted message', () => {
		expect(readCallerMessageFields({})).toBeUndefined();
		expect(readCallerMessageFields({ fromSessionId: 42 })).toBeUndefined();
		expect(readCallerMessageFields({ fromSessionId: ' ' })).toBeUndefined();
		expect(readCallerMessageFields({ fromSessionId: 'agent-1', fromTabId: 7 })).toEqual({
			fromSessionId: 'agent-1',
		});
	});
});

describe('isSelfDispatch', () => {
	const caller = { fromSessionId: 'agent-1', fromTabId: 'tab-1' };

	it('is false for a different agent', () => {
		expect(isSelfDispatch(caller, 'agent-2')).toBe(false);
		expect(isSelfDispatch(caller, 'agent-2', 'tab-1')).toBe(false);
	});

	it('is true for the caller own tab, named or implied by the active tab', () => {
		expect(isSelfDispatch(caller, 'agent-1', 'tab-1')).toBe(true);
		expect(isSelfDispatch(caller, 'agent-1')).toBe(true);
	});

	it('is false for another tab in the same agent, which is a real hand-off', () => {
		expect(isSelfDispatch(caller, 'agent-1', 'tab-2')).toBe(false);
	});
});
