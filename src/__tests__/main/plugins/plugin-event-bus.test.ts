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

	it('delivers tool.executed metadata and strips a smuggled state object', () => {
		let received: PluginEvent | undefined;
		const push = vi.fn((_id: string, e: PluginEvent) => {
			received = e;
			return true;
		});
		const bus = new PluginEventBusImpl({ isPermitted: () => true, push });
		bus.subscribe('a', ['tool.executed']);
		bus.emit(
			ev('tool.executed', {
				sessionId: 's1',
				toolName: 'Read',
				toolCallId: 'call-1',
				phase: 'completed',
				timestamp: 1700000000000,
				// A buggy emit site smuggling the tool's state blob: must not survive.
				state: { input: { path: '/etc/passwd' }, output: 'file contents' },
			})
		);
		expect(push).toHaveBeenCalledTimes(1);
		expect(received?.payload).toEqual({
			sessionId: 's1',
			toolName: 'Read',
			toolCallId: 'call-1',
			phase: 'completed',
			timestamp: 1700000000000,
		});
		expect(received?.payload).not.toHaveProperty('state');
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

	describe('per-topic capability gating (FC4)', () => {
		it('withholds history.entryAdded from a subscriber without history:read', () => {
			const push = vi.fn(() => true);
			const onDelivery = vi.fn();
			const bus = new PluginEventBusImpl({
				isPermitted: () => true,
				hasCapability: () => false, // holds events:subscribe but NOT history:read
				push,
				onDelivery,
			});
			bus.subscribe('a', ['history.entryAdded']);
			bus.emit(ev('history.entryAdded', { entryId: 'e1', kind: 'AUTO' }));
			expect(push).not.toHaveBeenCalled();
			expect(onDelivery).toHaveBeenCalledWith('a', 'history.entryAdded', false);
			// Withheld, NOT pruned: a later grant resumes delivery.
			expect(bus.topicsFor('a')).toEqual(['history.entryAdded']);
		});

		it('delivers history.entryAdded to a subscriber holding history:read', () => {
			const push = vi.fn(() => true);
			const bus = new PluginEventBusImpl({
				isPermitted: () => true,
				hasCapability: (_pluginId, capability) => capability === 'history:read',
				push,
			});
			bus.subscribe('a', ['history.entryAdded']);
			bus.emit(ev('history.entryAdded', { entryId: 'e1', kind: 'AUTO' }));
			expect(push).toHaveBeenCalledTimes(1);
		});

		it('gates agent.completed on agents:read', () => {
			const push = vi.fn(() => true);
			const capable = vi.fn(
				(_pluginId: string, capability: string) => capability === 'agents:read'
			);
			const bus = new PluginEventBusImpl({
				isPermitted: () => true,
				hasCapability: capable,
				push,
			});
			bus.subscribe('a', ['agent.completed']);
			bus.emit(ev('agent.completed', { sessionId: 's1', status: 'completed' }));
			expect(capable).toHaveBeenCalledWith('a', 'agents:read');
			expect(push).toHaveBeenCalledTimes(1);
		});

		it('FAILS CLOSED: gated topics reach nobody when no hasCapability dep is wired', () => {
			const push = vi.fn(() => true);
			const bus = new PluginEventBusImpl({ isPermitted: () => true, push });
			bus.subscribe('a', ['history.entryAdded', 'agent.completed']);
			bus.emit(ev('history.entryAdded', { entryId: 'e1' }));
			bus.emit(ev('agent.completed', { sessionId: 's1', status: 'completed' }));
			expect(push).not.toHaveBeenCalled();
		});

		it('re-checks the capability on EVERY delivery (instant revoke, instant re-grant)', () => {
			let granted = true;
			const push = vi.fn(() => true);
			const bus = new PluginEventBusImpl({
				isPermitted: () => true,
				hasCapability: () => granted,
				push,
			});
			bus.subscribe('a', ['history.entryAdded']);
			bus.emit(ev('history.entryAdded', { entryId: 'e1' }));
			expect(push).toHaveBeenCalledTimes(1);

			granted = false; // capability revoked between deliveries
			bus.emit(ev('history.entryAdded', { entryId: 'e2' }));
			expect(push).toHaveBeenCalledTimes(1);

			granted = true; // re-grant: subscription survived, delivery resumes
			bus.emit(ev('history.entryAdded', { entryId: 'e3' }));
			expect(push).toHaveBeenCalledTimes(2);
		});

		it('leaves ungated topics untouched by the capability checker', () => {
			const push = vi.fn(() => true);
			const capable = vi.fn(() => false);
			const bus = new PluginEventBusImpl({
				isPermitted: () => true,
				hasCapability: capable,
				push,
			});
			bus.subscribe('a', ['agent.exited', 'session.created']);
			bus.emit(ev('agent.exited', { sessionId: 's1', exitCode: 0 }));
			bus.emit(ev('session.created', { sessionId: 's1' }));
			expect(push).toHaveBeenCalledTimes(2);
			expect(capable).not.toHaveBeenCalled();
		});
	});
});
