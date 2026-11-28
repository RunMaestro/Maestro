/**
 * @fileoverview A headless host answers `cross_agent_cancel` (G1): Stop on an asker on another
 * machine reaches the consults it has running here, through the runtime's `consults.cancel`.
 */

import { describe, expect, it, vi } from 'vitest';
import { createRequestHandler } from '../../../../shared/maestro-lib/runtime/server-requests';
import type { MaestroClient } from '../../../../shared/maestro-lib/client/types';

describe('cross_agent_cancel on a headless host', () => {
	it('stops the asker by its key and reports how many', async () => {
		const cancel = vi.fn(async () => ({ ok: true as const, value: { canceled: 1 } }));
		const handle = createRequestHandler({ consults: { cancel } } as unknown as MaestroClient);
		expect(await handle({ type: 'cross_agent_cancel', askerKey: 'm/a/t' })).toEqual({
			type: 'cross_agent_cancel_result',
			success: true,
			canceled: 1,
		});
		expect(cancel).toHaveBeenCalledWith({ askerKey: 'm/a/t' });
	});

	it('refuses, saying so, when the runtime cannot stop a consult', async () => {
		const handle = createRequestHandler({ consults: {} } as unknown as MaestroClient);
		expect(await handle({ type: 'cross_agent_cancel', askerKey: 'm/a/t' })).toMatchObject({
			type: 'cross_agent_cancel_result',
			success: false,
		});
	});
});
