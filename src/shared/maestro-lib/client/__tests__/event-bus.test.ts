import { describe, expect, it, vi } from 'vitest';
import { createEventBus, matchesFilter } from '../event-bus';
import type { MaestroEvent } from '../types';

const agentEvent = (id: string): MaestroEvent => ({
	type: 'agent.updated',
	agent: { id, name: id, toolType: 'codex' },
});

describe('event bus', () => {
	it('delivers synchronously, in emit order', () => {
		const bus = createEventBus('[test]');
		const seen: string[] = [];
		bus.subscribe((event) => seen.push(event.type));
		bus.emitAll([agentEvent('a'), { type: 'agent.removed', agentId: 'a' }]);
		expect(seen).toEqual(['agent.updated', 'agent.removed']);
	});

	it('stops delivering after unsubscribe, and unsubscribing twice is harmless', () => {
		const bus = createEventBus('[test]');
		const listener = vi.fn();
		const off = bus.subscribe(listener);
		bus.emit(agentEvent('a'));
		off();
		off();
		bus.emit(agentEvent('a'));
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('keeps delivering to the others when one listener throws', () => {
		const bus = createEventBus('[test]');
		const after = vi.fn();
		bus.subscribe(() => {
			throw new Error('boom');
		});
		bus.subscribe(after);
		expect(() => bus.emit(agentEvent('a'))).not.toThrow();
		expect(after).toHaveBeenCalledTimes(1);
	});

	it('lets a listener unsubscribe itself mid-emit without skipping the next one', () => {
		const bus = createEventBus('[test]');
		const second = vi.fn();
		const off = bus.subscribe(() => off());
		bus.subscribe(second);
		bus.emit(agentEvent('a'));
		expect(second).toHaveBeenCalledTimes(1);
	});

	describe('matchesFilter', () => {
		it('passes everything without a filter', () => {
			expect(matchesFilter(agentEvent('a'), undefined)).toBe(true);
		});

		it('narrows by type', () => {
			expect(matchesFilter(agentEvent('a'), { types: ['agent.removed'] })).toBe(false);
			expect(matchesFilter(agentEvent('a'), { types: ['agent.updated'] })).toBe(true);
		});

		it('narrows agent-scoped events by agent and always passes the unscoped ones', () => {
			const filter = { agentId: 'a' };
			expect(matchesFilter(agentEvent('a'), filter)).toBe(true);
			expect(matchesFilter(agentEvent('b'), filter)).toBe(false);
			expect(matchesFilter({ type: 'tab.removed', agentId: 'b', tabId: 't' }, filter)).toBe(false);
			expect(matchesFilter({ type: 'tab.removed', agentId: 'a', tabId: 't' }, filter)).toBe(true);
			expect(matchesFilter({ type: 'groups.changed', groups: [] }, filter)).toBe(true);
			expect(matchesFilter({ type: 'settings.changed', keys: 'unknown' }, filter)).toBe(true);
		});
	});
});
