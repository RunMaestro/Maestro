import { describe, expect, it, vi } from 'vitest';
import {
	createOmpWorkspaceAdapter,
	type OmpPanelPort,
} from '../../../../plugins/com.maestro.omp/src/panel/OmpPanelPort';

const snapshot = {
	connection: 'ready' as const,
	models: [],
	sessions: [],
	activeSessionId: null,
};

describe('createOmpWorkspaceAdapter', () => {
	it('maps the typed workspace adapter to exact closed panel request kinds', async () => {
		const request = vi.fn(async (kind: string) => ({ kind, requestId: 'r-1', payload: snapshot }));
		const port: OmpPanelPort = {
			request,
			subscribe: vi.fn(() => () => {}),
		};
		const adapter = createOmpWorkspaceAdapter(port);

		expect(await adapter.getSnapshot()).toEqual(snapshot);
		await adapter.setMode('session-a', 'plan');
		await adapter.resolveApproval('session-a', 'approval-a', true);

		expect(request).toHaveBeenNthCalledWith(1, 'omp.workspace.snapshot', {});
		expect(request).toHaveBeenNthCalledWith(2, 'omp.session.set-mode', {
			sessionId: 'session-a',
			mode: 'plan',
		});
		expect(request).toHaveBeenNthCalledWith(3, 'omp.approval.resolve', {
			sessionId: 'session-a',
			requestId: 'approval-a',
			approved: true,
		});
	});
});
