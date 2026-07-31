/**
 * Tests for the main-process Provider Failover overlay registry - the map the
 * spawn handler reads to decide whether an agent's turn goes to a backup endpoint.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	setFailoverOverlay,
	getFailoverOverlay,
	getFailoverModel,
	clearAllFailoverOverlays,
} from '../../../main/process-manager/failover-overlay';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ZAI_ENV = { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' };

beforeEach(() => {
	clearAllFailoverOverlays();
});

describe('failover overlay registry', () => {
	it('stores and reads back an agent’s endpoint env and model', () => {
		setFailoverOverlay('agent-1', ZAI_ENV, 'glm-4.6');

		expect(getFailoverOverlay('agent-1')).toEqual(ZAI_ENV);
		expect(getFailoverModel('agent-1')).toBe('glm-4.6');
	});

	it('reports no overlay for an agent that never failed over', () => {
		expect(getFailoverOverlay('agent-unknown')).toBeUndefined();
		expect(getFailoverModel('agent-unknown')).toBeUndefined();
	});

	it('clears the model when the next endpoint declares none', () => {
		setFailoverOverlay('agent-1', ZAI_ENV, 'glm-4.6');
		setFailoverOverlay('agent-1', { ANTHROPIC_BASE_URL: 'http://localhost:8000' });

		// A stale model from the previous endpoint would be sent to a provider that
		// has never heard of it.
		expect(getFailoverModel('agent-1')).toBeUndefined();
	});

	it('treats a blank model as no model', () => {
		setFailoverOverlay('agent-1', ZAI_ENV, '   ');
		expect(getFailoverModel('agent-1')).toBeUndefined();
	});

	it('a null env returns the agent to its primary', () => {
		setFailoverOverlay('agent-1', ZAI_ENV, 'glm-4.6');
		setFailoverOverlay('agent-1', null);

		expect(getFailoverOverlay('agent-1')).toBeUndefined();
		expect(getFailoverModel('agent-1')).toBeUndefined();
	});

	it('keeps agents independent', () => {
		setFailoverOverlay('agent-1', ZAI_ENV);
		setFailoverOverlay('agent-2', { ANTHROPIC_BASE_URL: 'http://localhost:8000' });
		setFailoverOverlay('agent-1', null);

		expect(getFailoverOverlay('agent-1')).toBeUndefined();
		expect(getFailoverOverlay('agent-2')).toEqual({ ANTHROPIC_BASE_URL: 'http://localhost:8000' });
	});

	it('ignores an empty session id rather than creating a blank-keyed pin', () => {
		setFailoverOverlay('', ZAI_ENV);
		expect(getFailoverOverlay('')).toBeUndefined();
	});
});
