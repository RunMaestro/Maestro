import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

import {
	armEffortFallback,
	isEffortFallbackArmed,
	observeEffortRejection,
	settleEffortFallback,
} from '../../../renderer/services/effortRejection';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import { resetEffortRejections } from '../../../shared/effortRejection';
import { resolveEffortLevel } from '../../../shared/modelTiers';

function refusal(value = 'low') {
	return {
		agentId: 'codex',
		message: `{"type":"error","error":{"message":"Unsupported value: '${value}' is not supported with the 'gpt-6-astra' model. Supported values are: 'medium', 'high'.","type":"invalid_request_error","param":"reasoning.effort","code":"unsupported_value"},"status":400}`,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	resetEffortRejections();
});

describe('observeEffortRejection', () => {
	it('returns null and does nothing for an ordinary agent error', () => {
		expect(
			observeEffortRejection('sess-1-ai-tab-1', { agentId: 'codex', message: 'Rate limited' })
		).toBeNull();
		expect(notifyToast).not.toHaveBeenCalled();
		expect(resolveEffortLevel('codex', 'low')).toBe('low');
	});

	it('takes the refused value out of the effort ladder', () => {
		expect(resolveEffortLevel('codex', 'low')).toBe('low');

		// A main-process spawn the renderer has no retry for: it still counts.
		observeEffortRejection('tab-naming-abc', refusal());

		expect(resolveEffortLevel('codex', 'low')).toBeUndefined();
	});

	it('tells the user what was refused and what happens instead', () => {
		observeEffortRejection('tab-naming-abc', refusal());

		expect(notifyToast).toHaveBeenCalledTimes(1);
		const toast = vi.mocked(notifyToast).mock.calls[0][0];
		expect(toast.color).toBe('yellow');
		expect(toast.title).toBe('Codex rejected effort "low"');
		expect(toast.message).toContain('for gpt-6-astra');
		expect(toast.message).toContain('It accepts medium, high.');
		expect(toast.message).toContain("use the agent's configured effort");
	});

	it('toasts once per provider and value, however many turns hit it', () => {
		observeEffortRejection('tab-naming-1', refusal());
		observeEffortRejection('tab-naming-2', refusal());
		observeEffortRejection('sess-1-synopsis-3', refusal());
		expect(notifyToast).toHaveBeenCalledTimes(1);

		observeEffortRejection('tab-naming-4', refusal('xhigh'));
		expect(notifyToast).toHaveBeenCalledTimes(2);
	});

	it('still reports the refusal when the error names no agent', () => {
		const result = observeEffortRejection('tab-naming-1', { message: refusal().message });

		expect(result?.value).toBe('low');
		// Without a provider there is nothing to note it under, and no toast.
		expect(notifyToast).not.toHaveBeenCalled();
		expect(resolveEffortLevel('codex', 'low')).toBe('low');
	});
});

describe('arming a spawn to retry', () => {
	it('holds a refusal for an armed id until the spawn settles', () => {
		armEffortFallback('sess-1-batch-100');
		expect(isEffortFallbackArmed('sess-1-batch-100')).toBe(true);

		observeEffortRejection('sess-1-batch-100', refusal());

		expect(settleEffortFallback('sess-1-batch-100')).toEqual({
			value: 'low',
			model: 'gpt-6-astra',
			supported: ['medium', 'high'],
		});
		// Settling disarms and hands the refusal over exactly once.
		expect(isEffortFallbackArmed('sess-1-batch-100')).toBe(false);
		expect(settleEffortFallback('sess-1-batch-100')).toBeNull();
	});

	it('settles to null when the armed spawn was never refused', () => {
		armEffortFallback('sess-1-batch-200');
		expect(settleEffortFallback('sess-1-batch-200')).toBeNull();
		expect(isEffortFallbackArmed('sess-1-batch-200')).toBe(false);
	});

	it('never holds a refusal for an id nobody armed', () => {
		// Tab turns, naming and grooming have no renderer-side retry; holding
		// their refusals would grow the map for the life of the app.
		observeEffortRejection('sess-1-ai-tab-1', refusal());

		expect(isEffortFallbackArmed('sess-1-ai-tab-1')).toBe(false);
		expect(settleEffortFallback('sess-1-ai-tab-1')).toBeNull();
	});

	it('does not hold a refusal that arrives after the spawn settled', () => {
		armEffortFallback('sess-1-batch-300');
		settleEffortFallback('sess-1-batch-300');

		observeEffortRejection('sess-1-batch-300', refusal());

		expect(settleEffortFallback('sess-1-batch-300')).toBeNull();
	});

	it('keeps armed spawns apart', () => {
		armEffortFallback('sess-1-batch-400');
		armEffortFallback('sess-2-batch-400');

		observeEffortRejection('sess-2-batch-400', refusal());

		expect(settleEffortFallback('sess-1-batch-400')).toBeNull();
		expect(settleEffortFallback('sess-2-batch-400')?.value).toBe('low');
	});
});
