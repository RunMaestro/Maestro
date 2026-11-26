/**
 * @fileoverview A headless host answers `closed_tab_command` (G5): the desktop's message for
 * Cmd+Shift+T and `maestro-cli tab closed / reopen`, over the runtime's `tabs.closed` and
 * `tabs.reopen`, so a Federation peer reopens a hosted agent's tab where it runs.
 */

import { describe, expect, it, vi } from 'vitest';
import { createRequestHandler } from '../../../../shared/maestro-lib/runtime/server-requests';
import type { MaestroClient } from '../../../../shared/maestro-lib/client/types';

const summary = { index: 0, type: 'ai', label: 'Tax', tabId: 't1', closedAt: 5 };

describe('closed_tab_command on a headless host', () => {
	it('lists and reopens through the runtime', async () => {
		const closed = vi.fn(async () => ({ ok: true as const, value: [summary] }));
		const reopen = vi.fn(async () => ({ ok: true as const, value: { tabId: 't1' } }));
		const handle = createRequestHandler({ tabs: { closed, reopen } } as unknown as MaestroClient);
		expect(await handle({ type: 'closed_tab_command', action: 'list', sessionId: 'a1' })).toEqual({
			type: 'closed_tab_command_result',
			success: true,
			closedTabs: [summary],
		});
		expect(
			await handle({ type: 'closed_tab_command', action: 'reopen', sessionId: 'a1', tabId: 't1' })
		).toEqual({ type: 'closed_tab_command_result', success: true, tabId: 't1', tabType: 'ai' });
		expect(reopen).toHaveBeenCalledWith('a1', { tabId: 't1' });
	});

	it('refuses a malformed request and a runtime that keeps no closed tabs, saying so', async () => {
		const handle = createRequestHandler({ tabs: {} } as unknown as MaestroClient);
		expect(
			await handle({ type: 'closed_tab_command', action: 'reopen', sessionId: 'a1', index: -1 })
		).toMatchObject({ type: 'closed_tab_command_result', success: false });
		expect(
			await handle({ type: 'closed_tab_command', action: 'list', sessionId: 'a1' })
		).toMatchObject({ type: 'closed_tab_command_result', success: false });
	});
});
