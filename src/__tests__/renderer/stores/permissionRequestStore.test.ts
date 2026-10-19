/**
 * Tests for permissionRequestStore.forget: a tab window drops the prompts of a
 * tab that docked WITHOUT answering them, because main re-delivers each one to
 * the window that shows the tab now (Tab Windows). Answering would deny a
 * request the user can still answer there.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	usePermissionRequestStore,
	type PermissionRequestUI,
} from '../../../renderer/stores/permissionRequestStore';

const respondPermission = vi.fn().mockResolvedValue(true);

function request(requestId: string, tabId: string): PermissionRequestUI {
	return {
		requestId,
		sessionId: `agent-1-ai-${tabId}`,
		tabId,
		toolName: 'Bash',
		input: {},
		createdAt: 0,
	};
}

beforeEach(() => {
	respondPermission.mockClear();
	(window as any).maestro = { ...(window as any).maestro, process: { respondPermission } };
	usePermissionRequestStore.setState({ queue: [] });
});

describe('permissionRequestStore.forget', () => {
	it('drops the matching requests without answering them', () => {
		const { enqueue, forget } = usePermissionRequestStore.getState();
		enqueue(request('r1', 'docked'));
		enqueue(request('r2', 'shown'));

		forget((r) => r.tabId === 'docked');

		expect(usePermissionRequestStore.getState().queue.map((r) => r.requestId)).toEqual(['r2']);
		expect(respondPermission).not.toHaveBeenCalled();
	});

	it('keeps its state when nothing matches', () => {
		usePermissionRequestStore.getState().enqueue(request('r1', 'shown'));
		const before = usePermissionRequestStore.getState();
		before.forget(() => false);
		expect(usePermissionRequestStore.getState().queue).toBe(before.queue);
	});
});
