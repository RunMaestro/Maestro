import { describe, expect, it } from 'vitest';
import {
	parseHarnessControlCapabilities,
	parseHarnessInteractionRequest,
	parseHarnessInteractionResponse,
} from '../../../shared/harness-control/validators';

const capabilities = {
	protocol: 'acp',
	protocolVersion: '1',
	steering: 'none',
	permissionRequests: true,
	questions: false,
	elicitations: false,
	modelSwitch: true,
	modeSwitch: true,
	imagePrompts: false,
	resume: true,
};

const permissionRequest = {
	requestId: 'request-a',
	sessionId: 'session-a',
	spawnGeneration: 1,
	kind: 'permission',
	provider: 'fixture',
	title: 'Run tests?',
	options: [{ optionId: 'allow', label: 'Allow once', kind: 'allow-once' }],
	createdAt: 1,
};

describe('harness-control validators', () => {
	it('accepts negotiated capabilities and rejects unsupported protocol values', () => {
		expect(parseHarnessControlCapabilities(capabilities)).toEqual(capabilities);
		expect(parseHarnessControlCapabilities({ ...capabilities, protocol: 'future' })).toBeNull();
		expect(parseHarnessControlCapabilities({ ...capabilities, resume: undefined })).toBeNull();
	});

	it('rejects duplicate option IDs and permission requests without options', () => {
		expect(
			parseHarnessInteractionRequest({
				...permissionRequest,
				options: [...permissionRequest.options, ...permissionRequest.options],
			})
		).toBeNull();
		expect(parseHarnessInteractionRequest({ ...permissionRequest, options: [] })).toBeNull();
	});

	it('preserves question descriptions, required flags, and defaults', () => {
		const question = {
			id: 'enabled',
			question: 'Enable it?',
			description: 'Defaults to the provider setting',
			required: false,
			default: 'true',
			allowEmpty: true,
			options: [],
		};
		expect(
			parseHarnessInteractionRequest({
				...permissionRequest,
				kind: 'elicitation',
				options: [],
				questions: [question],
			})?.questions
		).toEqual([question]);
		expect(
			parseHarnessInteractionRequest({
				...permissionRequest,
				kind: 'elicitation',
				options: [],
				questions: [{ ...question, default: 1 }],
			})
		).toBeNull();
	});

	it('validates selected, answer, and cancellation responses', () => {
		expect(
			parseHarnessInteractionResponse({
				requestId: 'request-a',
				outcome: 'selected',
				optionId: 'allow',
			})
		).toEqual({ requestId: 'request-a', outcome: 'selected', optionId: 'allow' });
		expect(
			parseHarnessInteractionResponse({
				requestId: 'request-a',
				outcome: 'answers',
				answers: { choice: ['native', 'current'] },
			})
		).toEqual({
			requestId: 'request-a',
			outcome: 'answers',
			answers: { choice: ['native', 'current'] },
		});
		expect(
			parseHarnessInteractionResponse({
				requestId: 'request-a',
				outcome: 'cancelled',
				reason: 'cancelled',
			})
		).toEqual({ requestId: 'request-a', outcome: 'cancelled', reason: 'cancelled' });
	});

	it('rejects malformed and approval-shaped answer payloads', () => {
		expect(parseHarnessInteractionResponse(null)).toBeNull();
		expect(
			parseHarnessInteractionResponse({ requestId: 'request-a', outcome: 'selected', optionId: '' })
		).toBeNull();
		expect(
			parseHarnessInteractionResponse({
				requestId: 'request-a',
				outcome: 'answers',
				answers: { choice: ['native', 1] },
			})
		).toBeNull();
		expect(
			parseHarnessInteractionResponse({
				requestId: 'request-a',
				outcome: 'cancelled',
				reason: 'approved',
			})
		).toBeNull();
	});
});
