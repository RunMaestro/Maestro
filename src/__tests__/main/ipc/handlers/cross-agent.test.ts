/**
 * Tests for resolveCrossAgentWritable in src/main/ipc/handlers/cross-agent.ts
 *
 * A consult and a hand-off have separate write switches with opposite defaults:
 * a consult answers a question (read-only unless opted in), a hand-off passes
 * work on (may write unless opted out).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resolveCrossAgentWritable } from '../../../../main/ipc/handlers/cross-agent';

/** A settings store holding only `values`; anything else gets the caller's default. */
function store(values: Record<string, unknown>) {
	return {
		get: <T>(key: string, defaultValue?: T): T => (key in values ? values[key] : defaultValue) as T,
	};
}

describe('resolveCrossAgentWritable', () => {
	it('keeps a consult read-only and lets a hand-off write when nothing is set', () => {
		expect(resolveCrossAgentWritable({}, store({}))).toBe(false);
		expect(resolveCrossAgentWritable({ handoffAnswer: 'findings' }, store({}))).toBe(true);
	});

	it('reads each kind from its own switch only', () => {
		const settings = store({ crossAgentMentionsWritable: true, crossAgentHandoffsWritable: false });

		expect(resolveCrossAgentWritable({}, settings)).toBe(true);
		expect(resolveCrossAgentWritable({ handoffAnswer: 'findings' }, settings)).toBe(false);
	});

	it('treats an empty answer as a hand-off, not a consult', () => {
		// The field's presence is the marker; an agent can legitimately answer with "".
		expect(resolveCrossAgentWritable({ handoffAnswer: '' }, store({}))).toBe(true);
	});
});
