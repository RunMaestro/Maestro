import { describe, it, expect } from 'vitest';
import { ClaudeOutputParser } from '../../../main/parsers/claude-output-parser';

describe('rate_limit_event caching', () => {
	it('should cache resetsAt from rate_limit_event and attach to next rate_limited error', () => {
		const parser = new ClaudeOutputParser();
		const futureResetEpochSeconds = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

		// Step 1: Process the rate_limit_event line (arrives BEFORE the error)
		const rateLimitEvent = {
			type: 'rate_limit_event',
			rate_limit_info: {
				status: 'rejected',
				resetsAt: futureResetEpochSeconds,
				rateLimitType: 'five_hour',
				overageStatus: 'rejected',
				overageDisabledReason: 'org_level_disabled',
				isUsingOverage: false,
			},
			uuid: '50dbdb0f-6850-4c32-bf93-866c1f59cfd3',
			session_id: '1ceebdef-cc2a-4d09-b5ac-1191b7042d09',
		};

		// This should cache the resetsAt
		const event1 = parser.parseJsonObject(rateLimitEvent);
		expect(event1?.type).toBe('system');

		// Verify internal cache
		expect((parser as any).lastRateLimitResetAt).toBe(futureResetEpochSeconds * 1000);

		// Step 2: Process the assistant error line
		const assistantError = {
			type: 'assistant',
			message: {
				id: 'b858a1c7-0823-4e5d-8bd1-c82eb350316d',
				model: '<synthetic>',
				role: 'assistant',
				stop_reason: 'stop_sequence',
				stop_sequence: '',
				type: 'message',
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
				},
				content: [{ type: 'text', text: "You've hit your limit · resets 3pm (America/Winnipeg)" }],
			},
			session_id: '1ceebdef-cc2a-4d09-b5ac-1191b7042d09',
			uuid: '8b7f641e-799f-4b24-895a-8a66baa75919',
			error: 'rate_limit',
		};

		// This should detect the error AND attach rateLimitResetAt
		const agentError = parser.detectErrorFromParsed(assistantError);

		expect(agentError).not.toBeNull();
		expect(agentError!.type).toBe('rate_limited');
		expect(agentError!.rateLimitResetAt).toBe(futureResetEpochSeconds * 1000);

		// Cache should be cleared after use
		expect((parser as any).lastRateLimitResetAt).toBeNull();
	});

	it('should fall back to content text parsing if no rate_limit_event was received', () => {
		const parser = new ClaudeOutputParser();

		// No rate_limit_event processed — go straight to assistant error
		const assistantError = {
			type: 'assistant',
			message: {
				content: [{ type: 'text', text: "You've hit your limit · resets 3pm (America/Winnipeg)" }],
			},
			session_id: 'test',
			uuid: 'test',
			error: 'rate_limit',
		};

		const agentError = parser.detectErrorFromParsed(assistantError);

		expect(agentError).not.toBeNull();
		expect(agentError!.type).toBe('rate_limited');
		// Should have a reset time from content text parsing
		expect(agentError!.rateLimitResetAt).toBeDefined();
		const now = Date.now();
		expect(agentError!.rateLimitResetAt).toBeGreaterThan(now);
		expect(agentError!.rateLimitResetAt).toBeLessThan(now + 86400000);
	});
});
