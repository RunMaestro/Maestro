import { describe, expect, it } from 'vitest';
import { initialOmpWorkspaceState, reduceOmpWorkspaceState } from '../useOmpWorkspace';
import type { OmpWorkspaceSnapshot } from '../types';

const readySnapshot: OmpWorkspaceSnapshot = {
	connection: 'ready',
	models: [],
	sessions: [],
	activeSessionId: null,
};

describe('reduceOmpWorkspaceState', () => {
	it('moves from loading to ready when the adapter publishes its first snapshot', () => {
		const state = reduceOmpWorkspaceState(initialOmpWorkspaceState, {
			type: 'snapshot',
			snapshot: readySnapshot,
		});

		expect(state).toEqual({ snapshot: readySnapshot, phase: 'ready', loadError: null });
	});

	it('retains the last snapshot while surfacing a load failure for recovery UI', () => {
		const loaded = reduceOmpWorkspaceState(initialOmpWorkspaceState, {
			type: 'snapshot',
			snapshot: readySnapshot,
		});
		const failed = reduceOmpWorkspaceState(loaded, {
			type: 'load-error',
			message: 'Transport disconnected',
		});

		expect(failed).toEqual({
			snapshot: readySnapshot,
			phase: 'error',
			loadError: 'Transport disconnected',
		});
	});
});
