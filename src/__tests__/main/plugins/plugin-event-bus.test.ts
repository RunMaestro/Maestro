/**
 * @file plugin-event-bus.test.ts
 * @description The host->plugin event bus fans out per-topic, RE-AUTHORIZES every
 * delivery against live grants (instant revoke + prune), and prunes dead sinks.
 */

import { describe, it, expect, vi } from 'vitest';
import { PluginEventBusImpl } from '../../../main/plugins/plugin-event-bus';
import type { PluginEvent, PluginEventTopic } from '../../../shared/plugins/events';

function ev(topic: PluginEventTopic, payload: unknown = {}): PluginEvent {
	return { topic, at: '2026-01-01T00:00:00Z', payload } as PluginEvent;
}

describe('PluginEventBusImpl', () => {
	it('subscribe keeps only catalog topics and reports the registered set', () => {
		const bus = new PluginEventBusImpl({ isPermitted: () => true, push: () => true });
		const res = bus.subscribe('p', [
			'session.created',
			'not.a.topic',
			'cue.fired',
		] as unknown as PluginEventTopic[]);
		expect(res.topics.sort()).toEqual(['cue.fired', 'session.created']);
	});

	it('emit fans out only to subscribers of that topic', () => {
		const push = vi.fn(() => true);
		const bus = new PluginEventBusImpl({ isPermitted: () => true, push });
		bus.subscribe('a', ['session.created']);
		bus.subscribe('b', ['cue.fired']);
		const e = ev('session.created', { sessionId: 's1' });
		bus.emit(e);
		expect(push).toHaveBeenCalledTimes(1);
		expect(push).toHaveBeenCalledWith('a', e);
	});

	it('RE-AUTHORIZES every delivery and prunes a revoked subscriber', () => {
		let permitted = true;
		const push = vi.fn(() => true);
		const bus = new PluginEventBusImpl({ isPermitted: () => permitted, push });
		bus.subscribe('a', ['agent.awaiting']);
		bus.emit(ev('agent.awaiting', { agentId: 'x' }));
		expect(push).toHaveBeenCalledTimes(1);

		permitted = false; // grant revoked between deliveries
		bus.emit(ev('agent.awaiting', { agentId: 'x' }));
		expect(push).toHaveBeenCalledTimes(1);
		expect(bus.topicsFor('a')).toEqual([]);

		permitted = true; // re-granting does NOT resurrect the pruned subscription
		bus.emit(ev('agent.awaiting', { agentId: 'x' }));
		expect(push).toHaveBeenCalledTimes(1);
	});

	it('prunes a subscriber whose sink reports it is gone', () => {
		const push = vi.fn(() => false); // plugin not running
		const bus = new PluginEventBusImpl({ isPermitted: () => true, push });
		bus.subscribe('a', ['session.removed']);
		bus.emit(ev('session.removed', { sessionId: 's' }));
		expect(push).toHaveBeenCalledTimes(1);
		expect(bus.topicsFor('a')).toEqual([]);
	});

	it('unsubscribe removes specific topics or all; clear drops everything', () => {
		const bus = new PluginEventBusImpl({ isPermitted: () => true, push: () => true });
		bus.subscribe('a', ['session.created', 'session.updated']);
		bus.unsubscribe('a', ['session.created']);
		expect(bus.topicsFor('a')).toEqual(['session.updated']);
		bus.unsubscribe('a');
		expect(bus.topicsFor('a')).toEqual([]);
		bus.subscribe('a', ['cue.fired']);
		bus.clear('a');
		expect(bus.topicsFor('a')).toEqual([]);
	});

	it('ignores an emit for an unknown topic', () => {
		const push = vi.fn(() => true);
		const bus = new PluginEventBusImpl({ isPermitted: () => true, push });
		bus.subscribe('a', ['session.created']);
		bus.emit({ topic: 'bogus', at: 'now', payload: {} } as unknown as PluginEvent);
		expect(push).not.toHaveBeenCalled();
	});

	it('strips non-primitive payload fields, delivering metadata only', () => {
		let received: PluginEvent | undefined;
		const push = vi.fn((_id: string, e: PluginEvent) => {
			received = e;
			return true;
		});
		const bus = new PluginEventBusImpl({ isPermitted: () => true, push });
		bus.subscribe('a', ['session.created']);
		bus.emit(
			ev('session.created', {
				sessionId: 's1',
				title: 'hello',
				count: 2,
				ok: true,
				empty: null,
				nested: { secret: 'transcript text' },
				list: ['a', 'b'],
				fn: () => 'x',
			})
		);
		expect(push).toHaveBeenCalledTimes(1);
		expect(received?.payload).toEqual({
			sessionId: 's1',
			title: 'hello',
			count: 2,
			ok: true,
			empty: null,
		});
	});

	it('drops the entire payload when it exceeds the serialized size cap', () => {
		let received: PluginEvent | undefined;
		const push = vi.fn((_id: string, e: PluginEvent) => {
			received = e;
			return true;
		});
		const bus = new PluginEventBusImpl({ isPermitted: () => true, push });
		bus.subscribe('a', ['cue.fired']);
		bus.emit(ev('cue.fired', { cueType: 'x'.repeat(20000) }));
		expect(push).toHaveBeenCalledTimes(1);
		expect(received?.payload).toEqual({});
	});
});
