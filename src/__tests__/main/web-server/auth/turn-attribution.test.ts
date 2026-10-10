import { describe, it, expect, beforeEach } from 'vitest';
import {
	forgetAgentActors,
	noteTurnActor,
	resetTurnActors,
	resolveTurnActor,
} from '../../../../main/web-server/auth/turn-attribution';

const user = { id: 'u1', username: 'pedram', displayName: 'Pedram' };

describe('turn attribution', () => {
	beforeEach(() => resetTurnActors());

	it('remembers who started the turn on a tab', () => {
		noteTurnActor('agent-1', 'tab-1', user);
		expect(resolveTurnActor('agent-1', 'tab-1')).toEqual(user);
		expect(resolveTurnActor('agent-1', 'tab-2')).toBeUndefined();
	});

	it('a desktop-started turn clears the phone that came before it', () => {
		noteTurnActor('agent-1', 'tab-1', user);
		noteTurnActor('agent-1', 'tab-1', undefined);
		expect(resolveTurnActor('agent-1', 'tab-1')).toBeUndefined();
	});

	it('treats a missing tab id as its own key', () => {
		noteTurnActor('agent-1', null, user);
		expect(resolveTurnActor('agent-1', undefined)).toEqual(user);
		expect(resolveTurnActor('agent-1', 'tab-1')).toBeUndefined();
	});

	it('forgets every tab of a closed agent and nothing else', () => {
		noteTurnActor('agent-1', 'tab-1', user);
		noteTurnActor('agent-1', 'tab-2', user);
		noteTurnActor('agent-10', 'tab-1', user);
		forgetAgentActors('agent-1');
		expect(resolveTurnActor('agent-1', 'tab-1')).toBeUndefined();
		expect(resolveTurnActor('agent-1', 'tab-2')).toBeUndefined();
		expect(resolveTurnActor('agent-10', 'tab-1')).toEqual(user);
	});
});
