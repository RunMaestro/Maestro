/**
 * Tests for agentEnvVarHandlers: the AgentEnvVarsSection callbacks over a
 * live record and a parked record (Edit Agent, the Group Chat moderator).
 */

import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { agentEnvVarHandlers } from '../../../../renderer/components/shared/agentEnvVarHandlers';

function useRecords(live: Record<string, string>, parked: Record<string, string>) {
	const [customEnvVars, setCustomEnvVars] = useState(live);
	const [customEnvVarsDisabled, setCustomEnvVarsDisabled] = useState(parked);
	return agentEnvVarHandlers({
		customEnvVars,
		customEnvVarsDisabled,
		setCustomEnvVars,
		setCustomEnvVarsDisabled,
	});
}

describe('agentEnvVarHandlers', () => {
	it('hands back both records', () => {
		const { result } = renderHook(() => useRecords({ A: '1' }, { B: '2' }));

		expect(result.current.customEnvVars).toEqual({ A: '1' });
		expect(result.current.customEnvVarsDisabled).toEqual({ B: '2' });
	});

	it('parks a live var and unparks it again, value intact and never in both', () => {
		const { result } = renderHook(() => useRecords({ A: '1', C: '3' }, {}));

		act(() => result.current.onEnvVarToggle!('A', false));
		expect(result.current.customEnvVars).toEqual({ C: '3' });
		expect(result.current.customEnvVarsDisabled).toEqual({ A: '1' });

		act(() => result.current.onEnvVarToggle!('A', true));
		expect(result.current.customEnvVars).toEqual({ C: '3', A: '1' });
		expect(result.current.customEnvVarsDisabled).toEqual({});
	});

	it('writes value edits, renames and removals to the record the row lives in', () => {
		const { result } = renderHook(() => useRecords({ A: '1' }, { B: '2' }));

		act(() => result.current.onEnvVarValueChange('A', 'one'));
		act(() => result.current.onEnvVarValueChange('B', 'two', false));
		expect(result.current.customEnvVars).toEqual({ A: 'one' });
		expect(result.current.customEnvVarsDisabled).toEqual({ B: 'two' });

		act(() => result.current.onEnvVarKeyChange('B', 'BB', 'two', false));
		expect(result.current.customEnvVarsDisabled).toEqual({ BB: 'two' });
		expect(result.current.customEnvVars).toEqual({ A: 'one' });

		act(() => result.current.onEnvVarRemove('A'));
		act(() => result.current.onEnvVarRemove('BB', false));
		expect(result.current.customEnvVars).toEqual({});
		expect(result.current.customEnvVarsDisabled).toEqual({});
	});

	it('adds a blank row to the live record', () => {
		const { result } = renderHook(() => useRecords({ A: '1' }, {}));

		act(() => result.current.onEnvVarAdd());

		expect(Object.keys(result.current.customEnvVars)).toHaveLength(2);
		expect(result.current.customEnvVars.A).toBe('1');
		expect(result.current.customEnvVarsDisabled).toEqual({});
	});
});
