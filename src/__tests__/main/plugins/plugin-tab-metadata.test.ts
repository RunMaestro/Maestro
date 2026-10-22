/**
 * @file plugin-tab-metadata.test.ts
 * @description Tests for `projectSessionTabMetadata` - the pure per-session
 * projection used by `pluginTabsList` in `src/main/index.ts`. Covers the
 * hidden-tab leak fix (a cross-agent consult tab with `hidden: true` must
 * never surface as a plugin card) alongside the existing field projection
 * and malformed-input tolerance.
 */

import { describe, it, expect } from 'vitest';
import { projectSessionTabMetadata } from '../../../main/plugins/plugin-tab-metadata';

describe('projectSessionTabMetadata', () => {
	it('omits hidden AI tabs', () => {
		const session = {
			id: 's1',
			cwd: '/project',
			aiTabs: [
				{ id: 'visible-tab', name: 'Visible', state: 'idle', createdAt: 1 },
				{ id: 'hidden-tab', name: 'Consult', state: 'idle', hidden: true, createdAt: 2 },
			],
			terminalTabs: [],
		};

		const result = projectSessionTabMetadata(session);

		expect(result).toHaveLength(1);
		expect(result[0]!.id).toBe('visible-tab');
		expect(result.some((t) => t.id === 'hidden-tab')).toBe(false);
	});

	it('keeps exactly the current fields for visible AI and terminal tabs', () => {
		const session = {
			id: 's1',
			cwd: '/project',
			aiTabs: [
				{
					id: 'ai-1',
					name: 'My Tab',
					state: 'busy',
					createdAt: 100,
					agentSessionId: 'agent-sess-1',
				},
			],
			terminalTabs: [{ id: 'term-1', name: 'Shell', state: 'idle', createdAt: 200 }],
		};

		const result = projectSessionTabMetadata(session);

		expect(result).toEqual([
			{
				id: 'ai-1',
				sessionId: 's1',
				type: 'ai',
				title: 'My Tab',
				status: 'busy',
				createdAt: 100,
				agentSessionId: 'agent-sess-1',
				projectPath: '/project',
			},
			{
				id: 'term-1',
				sessionId: 's1',
				type: 'terminal',
				title: 'Shell',
				status: 'idle',
				createdAt: 200,
				projectPath: '/project',
			},
		]);
	});

	it('omits optional fields that are absent or malformed on an otherwise-valid tab', () => {
		const session = {
			id: 's1',
			aiTabs: [{ id: 'ai-1', name: 42, state: null }],
			terminalTabs: [],
		};

		const result = projectSessionTabMetadata(session);

		expect(result).toEqual([{ id: 'ai-1', sessionId: 's1', type: 'ai' }]);
	});

	it('skips a malformed tab entry rather than throwing', () => {
		const session = {
			id: 's1',
			aiTabs: [null, 'not-an-object', 42, { id: 'ai-1', name: 'Fine' }, { name: 'No id' }],
			terminalTabs: [undefined, { noId: true }, { id: 'term-1', name: 'Shell' }],
		};

		expect(() => projectSessionTabMetadata(session)).not.toThrow();

		const result = projectSessionTabMetadata(session);

		expect(result.map((t) => t.id)).toEqual(['ai-1', 'term-1']);
	});

	it('returns an empty array for a session with a non-string id', () => {
		const result = projectSessionTabMetadata({ id: 123, aiTabs: [{ id: 'ai-1' }] });

		expect(result).toEqual([]);
	});

	it('returns an empty array when aiTabs and terminalTabs are missing or not arrays', () => {
		const result = projectSessionTabMetadata({ id: 's1' });

		expect(result).toEqual([]);
	});

	it('falls back to projectRoot when cwd is absent', () => {
		const session = {
			id: 's1',
			projectRoot: '/alt/root',
			aiTabs: [{ id: 'ai-1', name: 'Tab' }],
			terminalTabs: [],
		};

		const result = projectSessionTabMetadata(session);

		expect(result[0]!.projectPath).toBe('/alt/root');
	});
});
