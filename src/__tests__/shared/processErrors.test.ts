/**
 * The busy-agent refusal is matched by message text on the far side of the IPC
 * bridge, so these cases pin the exact shapes that have to keep matching. If
 * `ProcessManager` ever reworded the throw, the renderer carve-out would go
 * dead silently - which is the failure mode that kept prior Sentry filter rules
 * from ever firing in the field.
 */

import { describe, it, expect } from 'vitest';
import {
	AGENT_ALREADY_RUNNING_PREFIX,
	agentAlreadyRunningMessage,
	isAgentAlreadyRunningError,
} from '../../shared/processErrors';

describe('isAgentAlreadyRunningError', () => {
	it('matches the message ProcessManager actually throws', () => {
		expect(isAgentAlreadyRunningError(new Error(agentAlreadyRunningMessage('abc-ai-def')))).toBe(
			true
		);
	});

	it('matches it after Electron re-wraps it as an IPC rejection', () => {
		// Verbatim shape from the MAESTRO-ZS event.
		const wrapped = new Error(
			"Error invoking remote method 'process:spawn': Error: Agent process already running for " +
				'session d9f165e2-4254-4ec8-a614-8735878ee831-ai-f192f4eb-bc4f-4122-8f69-8b9e0c122691'
		);
		expect(isAgentAlreadyRunningError(wrapped)).toBe(true);
	});

	it('does not match other spawn failures', () => {
		expect(isAgentAlreadyRunningError(new Error('spawn ENOENT: claude'))).toBe(false);
		expect(isAgentAlreadyRunningError(new Error('Agent claude-code is not available'))).toBe(false);
	});

	it('handles non-Error values safely', () => {
		expect(isAgentAlreadyRunningError(null)).toBe(false);
		expect(isAgentAlreadyRunningError(undefined)).toBe(false);
		expect(isAgentAlreadyRunningError(AGENT_ALREADY_RUNNING_PREFIX)).toBe(true);
	});
});
