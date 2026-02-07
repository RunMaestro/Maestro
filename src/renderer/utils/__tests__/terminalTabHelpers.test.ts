import { describe, it, expect } from 'vitest';
import type { Session, TerminalTab } from '../../types';
import { addTerminalTab, updateTerminalTabPid } from '../terminalTabHelpers';

function createMockTerminalTab(): TerminalTab {
	return {
		id: 'tab-1',
		name: null,
		shellType: 'bash',
		pid: 123,
		cwd: '/repo',
		createdAt: 1700000000000,
		state: 'idle',
	};
}

function createMockSession(overrides: Partial<Session> = {}): Session {
	const initialTab = createMockTerminalTab();

	return {
		id: 'session-1',
		cwd: '/repo',
		terminalTabs: [initialTab],
		activeTerminalTabId: initialTab.id,
		...overrides,
	} as unknown as Session;
}

describe('terminalTabHelpers addTerminalTab', () => {
	it('adds a new tab and makes it active', () => {
		const session = createMockSession();

		const result = addTerminalTab(session, 'fish');

		expect(result.session.terminalTabs).toHaveLength(2);
		expect(result.session.activeTerminalTabId).toBe(result.tab.id);
		expect(result.tab.shellType).toBe('fish');
		expect(result.tab.cwd).toBe('/repo');
		expect(result.tab.name).toBeNull();
		expect(session.terminalTabs).toHaveLength(1);
		expect(session.activeTerminalTabId).toBe('tab-1');
	});

	it('uses zsh when shell type is not provided', () => {
		const session = createMockSession({ cwd: '/workspace/project' });

		const result = addTerminalTab(session);

		expect(result.tab.shellType).toBe('zsh');
		expect(result.tab.cwd).toBe('/workspace/project');
	});
});

describe('terminalTabHelpers updateTerminalTabPid', () => {
	it('updates pid for the matching tab', () => {
		const firstTab = createMockTerminalTab();
		const secondTab = { ...createMockTerminalTab(), id: 'tab-2', pid: 456 };
		const session = createMockSession({ terminalTabs: [firstTab, secondTab] });

		const updated = updateTerminalTabPid(session, 'tab-2', 999);

		expect(updated).not.toBe(session);
		expect(updated.terminalTabs[0].pid).toBe(123);
		expect(updated.terminalTabs[1].pid).toBe(999);
		expect(session.terminalTabs[1].pid).toBe(456);
	});

	it('returns original session when pid is unchanged', () => {
		const session = createMockSession();

		const updated = updateTerminalTabPid(session, 'tab-1', 123);

		expect(updated).toBe(session);
	});

	it('returns original session when tab does not exist', () => {
		const session = createMockSession();

		const updated = updateTerminalTabPid(session, 'missing-tab', 777);

		expect(updated).toBe(session);
	});
});
