import { describe, it, expect, beforeEach } from 'vitest';
import {
	requestCoworkingApproval,
	useCoworkingApprovalStore,
} from '../../../../renderer/stores/coworkingApprovalStore';
import { browserOpNeedsConfirm } from '../../../../shared/coworkingBrowser';

describe('coworkingApprovalStore', () => {
	beforeEach(() => {
		useCoworkingApprovalStore.setState({ queue: [] });
	});

	it('enqueues a request and resolves true when allowed', async () => {
		const p = requestCoworkingApproval({ agentId: 'a', sessionId: 's', title: 't', message: 'm' });
		const front = useCoworkingApprovalStore.getState().queue[0];
		expect(front).toBeDefined();
		useCoworkingApprovalStore.getState().settle(front.id, true);
		await expect(p).resolves.toBe(true);
		expect(useCoworkingApprovalStore.getState().queue).toHaveLength(0);
	});

	it('resolves false on decline/cancel (no hang)', async () => {
		const p = requestCoworkingApproval({ agentId: 'a', sessionId: 's', title: 't', message: 'm' });
		const front = useCoworkingApprovalStore.getState().queue[0];
		useCoworkingApprovalStore.getState().settle(front.id, false);
		await expect(p).resolves.toBe(false);
	});

	it('settling an unknown id is a no-op', () => {
		expect(() => useCoworkingApprovalStore.getState().settle('nope', true)).not.toThrow();
	});

	it('queues multiple requests in order', () => {
		void requestCoworkingApproval({ agentId: 'a', sessionId: 's', title: '1', message: 'm' });
		void requestCoworkingApproval({ agentId: 'a', sessionId: 's', title: '2', message: 'm' });
		const queue = useCoworkingApprovalStore.getState().queue;
		expect(queue.map((r) => r.title)).toEqual(['1', '2']);
	});
});

describe('browserOpNeedsConfirm', () => {
	it('never confirms read', () => {
		expect(browserOpNeedsConfirm('all', 'read')).toBe(false);
		expect(browserOpNeedsConfirm('dangerous', 'read')).toBe(false);
		expect(browserOpNeedsConfirm('off', 'read')).toBe(false);
	});

	it('off confirms only eval (force-confirmed); every other op runs immediately', () => {
		expect(browserOpNeedsConfirm('off', 'eval')).toBe(true);
		expect(browserOpNeedsConfirm('off', 'navigate')).toBe(false);
		expect(browserOpNeedsConfirm('off', 'click')).toBe(false);
		expect(browserOpNeedsConfirm('off', 'type')).toBe(false);
		expect(browserOpNeedsConfirm('off', 'reload')).toBe(false);
		expect(browserOpNeedsConfirm('off', 'newTab')).toBe(false);
		expect(browserOpNeedsConfirm('off', 'closeTab')).toBe(false);
	});

	it('all confirms every interaction op (read still excluded)', () => {
		expect(browserOpNeedsConfirm('all', 'eval')).toBe(true);
		expect(browserOpNeedsConfirm('all', 'navigate')).toBe(true);
		expect(browserOpNeedsConfirm('all', 'click')).toBe(true);
		expect(browserOpNeedsConfirm('all', 'reload')).toBe(true);
		expect(browserOpNeedsConfirm('all', 'type')).toBe(true);
		expect(browserOpNeedsConfirm('all', 'newTab')).toBe(true);
		expect(browserOpNeedsConfirm('all', 'closeTab')).toBe(true);
	});

	it('dangerous confirms the sharp-edge ops (navigate, eval, type, newTab, closeTab) and nothing else', () => {
		expect(browserOpNeedsConfirm('dangerous', 'eval')).toBe(true);
		expect(browserOpNeedsConfirm('dangerous', 'navigate')).toBe(true);
		expect(browserOpNeedsConfirm('dangerous', 'type')).toBe(true);
		expect(browserOpNeedsConfirm('dangerous', 'newTab')).toBe(true);
		expect(browserOpNeedsConfirm('dangerous', 'closeTab')).toBe(true);
		expect(browserOpNeedsConfirm('dangerous', 'click')).toBe(false);
		expect(browserOpNeedsConfirm('dangerous', 'reload')).toBe(false);
		expect(browserOpNeedsConfirm('dangerous', 'back')).toBe(false);
		expect(browserOpNeedsConfirm('dangerous', 'forward')).toBe(false);
		expect(browserOpNeedsConfirm('dangerous', 'stop')).toBe(false);
		expect(browserOpNeedsConfirm('dangerous', 'screenshot')).toBe(false);
		expect(browserOpNeedsConfirm('dangerous', 'waitFor')).toBe(false);
	});
});
