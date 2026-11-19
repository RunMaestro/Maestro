/**
 * The one entry point every way into the Playbook Configure modal uses.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
	closePlaybookConfigure,
	isPlaybookParamsPause,
	openPlaybookConfigure,
} from '../../../renderer/services/playbookConfigure';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';

function modal() {
	return useModalStore.getState().modals.get('playbookConfigure');
}

describe('openPlaybookConfigure', () => {
	beforeEach(() => {
		closePlaybookConfigure();
		useSessionStore.setState({ activeSessionId: 'agent-active' });
	});

	it('opens on the active agent when no agent is named', () => {
		openPlaybookConfigure();
		expect(modal()?.open).toBe(true);
		expect(modal()?.data).toEqual({ sessionId: 'agent-active' });
	});

	it('keeps a named agent and playbook', () => {
		openPlaybookConfigure({ sessionId: 'owner', playbookId: 'pb-1' });
		expect(modal()?.data).toEqual({ sessionId: 'owner', playbookId: 'pb-1' });
	});

	it('opens with no agent when none is active', () => {
		useSessionStore.setState({ activeSessionId: '' });
		openPlaybookConfigure();
		expect(modal()?.data).toEqual({});
	});

	it('closes', () => {
		openPlaybookConfigure();
		closePlaybookConfigure();
		expect(modal()?.open ?? false).toBe(false);
	});
});

describe('isPlaybookParamsPause', () => {
	it('is true only for the two parameter pauses', () => {
		expect(isPlaybookParamsPause('missing_parameters')).toBe(true);
		expect(isPlaybookParamsPause('parameter_substitution')).toBe(true);
		expect(isPlaybookParamsPause('hitl_gate')).toBe(false);
		expect(isPlaybookParamsPause('unknown')).toBe(false);
	});
});
