/**
 * @file events.test.ts
 * @description The host->plugin event catalog is a fixed, metadata-only set.
 */

import { describe, it, expect } from 'vitest';
import { isPluginEventTopic, PLUGIN_EVENT_TOPICS } from '../../../shared/plugins/events';

describe('plugin event topics', () => {
	it('recognizes exactly the catalog topics', () => {
		for (const t of PLUGIN_EVENT_TOPICS) expect(isPluginEventTopic(t)).toBe(true);
		expect(isPluginEventTopic('')).toBe(false);
		expect(isPluginEventTopic(42)).toBe(false);
		expect(isPluginEventTopic('not.a.topic')).toBe(false);
	});

	it('catalog carries NO raw-content topic (metadata-only guarantee)', () => {
		// A plugin must never receive message bodies / agent output over the bus.
		expect(PLUGIN_EVENT_TOPICS).not.toContain('agent.output');
		expect(PLUGIN_EVENT_TOPICS).not.toContain('session.message');
		expect(PLUGIN_EVENT_TOPICS).not.toContain('transcript.appended');
	});
});
