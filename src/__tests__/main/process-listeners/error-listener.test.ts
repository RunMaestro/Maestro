/**
 * Tests for setupErrorListener's handling of a provider refusing the effort
 * level a turn asked for.
 *
 * Every agent error in the main process passes through this one listener, so it
 * is where a refusal gets noted (taking the value out of the effort ladder for
 * the rest of the process) and reported. The report is the only way a drifted
 * ladder is learned about before a user complains: the failure it replaces was
 * a tab that silently never got a name.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../main/utils/sentry', () => ({
	captureMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../main/agents/capability-snapshot', () => ({
	capabilitySnapshots: { markAuthRequired: vi.fn() },
}));

import { setupErrorListener } from '../../../main/process-listeners/error-listener';
import { captureMessage } from '../../../main/utils/sentry';
import { getEffortRejection, resetEffortRejections } from '../../../shared/effortRejection';
import { resolveEffortLevel } from '../../../shared/modelTiers';
import type { AgentError } from '../../../shared/types';

function refusal(value: string, overrides: Partial<AgentError> = {}): AgentError {
	return {
		type: 'unknown',
		agentId: 'codex',
		recoverable: true,
		timestamp: 0,
		message: `{"type":"error","error":{"message":"Unsupported value: '${value}' is not supported with the 'gpt-6-astra' model. Supported values are: 'medium', 'high'.","type":"invalid_request_error","param":"reasoning.effort","code":"unsupported_value"},"status":400}`,
		...overrides,
	};
}

let processManager: EventEmitter;
let safeSend: ReturnType<typeof vi.fn>;
let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

beforeEach(() => {
	vi.clearAllMocks();
	processManager = new EventEmitter();
	safeSend = vi.fn();
	logger = { info: vi.fn(), warn: vi.fn() };
	setupErrorListener(processManager as never, { safeSend, logger } as never, vi.fn());
});

afterEach(() => {
	resetEffortRejections();
});

describe('setupErrorListener: effort refused by the provider', () => {
	it('still forwards the error to the renderer', () => {
		const error = refusal('low');
		processManager.emit('agent-error', 'tab-naming-1', error);

		expect(safeSend).toHaveBeenCalledWith('agent:error', 'tab-naming-1', error);
	});

	it('takes a refused ladder value out of circulation and reports it', () => {
		expect(resolveEffortLevel('codex', 'low')).toBe('low');

		processManager.emit('agent-error', 'tab-naming-1', refusal('low', { sshRemoteId: 'r1' }));

		expect(resolveEffortLevel('codex', 'low')).toBeUndefined();
		expect(captureMessage).toHaveBeenCalledWith(
			'Provider rejected an effort ladder value',
			'warning',
			{
				agentId: 'codex',
				value: 'low',
				model: 'gpt-6-astra',
				supported: ['medium', 'high'],
				viaSsh: true,
			}
		);
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it('reports each provider and value once, however many turns hit it', () => {
		processManager.emit('agent-error', 'tab-naming-1', refusal('low'));
		processManager.emit('agent-error', 'tab-naming-2', refusal('low'));
		processManager.emit('agent-error', 'groomer-3', refusal('low'));

		expect(captureMessage).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		// Every one of them is still forwarded.
		expect(safeSend).toHaveBeenCalledTimes(3);
	});

	it('notes a value the user picked but does not report it as ladder drift', () => {
		// `ultra` is offered in the Codex dropdown and never chosen by Maestro.
		// A model refusing it is the user's setting to change, not a stale table.
		processManager.emit('agent-error', 'agent-1-ai-tab-1', refusal('ultra'));

		expect(getEffortRejection('codex', 'ultra')).toBeDefined();
		expect(captureMessage).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it('does nothing extra for an ordinary agent error', () => {
		processManager.emit('agent-error', 'agent-1-ai-tab-1', {
			type: 'rate_limited',
			agentId: 'codex',
			recoverable: true,
			timestamp: 0,
			message: 'Rate limit reached',
		} satisfies AgentError);

		expect(captureMessage).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
		expect(resolveEffortLevel('codex', 'low')).toBe('low');
	});
});
