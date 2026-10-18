import { afterEach, describe, expect, it } from 'vitest';
import {
	describeEffortRejection,
	getEffortRejection,
	noteEffortRejection,
	parseAgentErrorEffortRejection,
	parseEffortRejection,
	resetEffortRejections,
} from '../../shared/effortRejection';

// Verbatim from a Codex-over-SSH tab naming run: the `AgentError.message` the
// main process logged when the API refused `minimal`.
const AGENT_ERROR_MESSAGE =
	'{"type":"error","error":{"message":"Unsupported value: \'minimal\' is not supported with the \'gpt-6-astra\' model. Supported values are: \'low\', \'medium\', \'high\', \'xhigh\', and \'max\'.","type":"invalid_request_error","param":"reasoning.effort","code":"unsupported_value"},"status":400}';

// The same refusal as `codex exec --json` prints it: the API's JSON is carried
// as a STRING inside a JSONL event, so every inner quote is backslash-escaped.
const JSONL_LINE = JSON.stringify({ type: 'error', message: AGENT_ERROR_MESSAGE });

afterEach(() => {
	resetEffortRejections();
});

describe('parseEffortRejection', () => {
	it('reads the value, the model, and the accepted values from an agent error', () => {
		expect(parseEffortRejection(AGENT_ERROR_MESSAGE)).toEqual({
			value: 'minimal',
			model: 'gpt-6-astra',
			supported: ['low', 'medium', 'high', 'xhigh', 'max'],
		});
	});

	it('reads the same refusal out of an escaped JSONL line', () => {
		expect(JSONL_LINE).toContain('\\"param\\":\\"reasoning.effort\\"');
		expect(parseEffortRejection(JSONL_LINE)).toEqual({
			value: 'minimal',
			model: 'gpt-6-astra',
			supported: ['low', 'medium', 'high', 'xhigh', 'max'],
		});
	});

	it('finds it inside a larger buffer of provider output', () => {
		const buffer = `{"type":"thread.started"}\n${JSONL_LINE}\n{"type":"turn.failed"}`;
		expect(parseEffortRejection(buffer)?.value).toBe('minimal');
	});

	it('keeps a model name that contains a dot', () => {
		const text = AGENT_ERROR_MESSAGE.replace('gpt-6-astra', 'gpt-6.1-sol');
		expect(parseEffortRejection(text)?.model).toBe('gpt-6.1-sol');
	});

	it('ignores the same sentence about a different parameter', () => {
		// The API words every unsupported-value refusal this way. Reading one
		// about verbosity as an effort refusal would strip the effort from a turn
		// that never had a problem with it.
		const other = AGENT_ERROR_MESSAGE.replace('reasoning.effort', 'text.verbosity');
		expect(parseEffortRejection(other)).toBeNull();
	});

	it('ignores an unrelated error that merely mentions the parameter', () => {
		expect(
			parseEffortRejection('{"param":"reasoning.effort","message":"rate limited"}')
		).toBeNull();
	});

	it('returns null for anything that is not a non-empty string', () => {
		expect(parseEffortRejection('')).toBeNull();
		expect(parseEffortRejection(undefined)).toBeNull();
		expect(parseEffortRejection(null)).toBeNull();
		expect(parseEffortRejection({ message: AGENT_ERROR_MESSAGE })).toBeNull();
	});

	it('still reports the value when the provider lists no alternatives', () => {
		const text =
			'{"error":{"message":"Unsupported value: \'minimal\' is not supported with the \'gpt-6-astra\' model.","param":"reasoning.effort"}}';
		expect(parseEffortRejection(text)).toEqual({
			value: 'minimal',
			model: 'gpt-6-astra',
			supported: [],
		});
	});

	it("reads Copilot CLI's refusal for a model with no effort knob", () => {
		// Verbatim from issue #1840: Copilot on its `auto` model.
		const text =
			'Error: Model "auto" does not support reasoning effort configuration (requested: "low").';
		expect(parseEffortRejection(text)).toEqual({ value: 'low', model: 'auto', supported: [] });
	});
});

describe('parseAgentErrorEffortRejection', () => {
	const COPILOT_STDERR =
		'Error: Model "auto" does not support reasoning effort configuration (requested: "low").';

	it('reads the message first', () => {
		expect(parseAgentErrorEffortRejection({ message: AGENT_ERROR_MESSAGE })?.value).toBe('minimal');
	});

	it('falls back to the raw stderr when the message is generic', () => {
		expect(
			parseAgentErrorEffortRejection({
				message: 'Agent exited with code 1',
				raw: { stderr: COPILOT_STDERR },
			})
		).toEqual({ value: 'low', model: 'auto', supported: [] });
	});

	it('returns null when no part carries a refusal', () => {
		expect(
			parseAgentErrorEffortRejection({
				message: 'Agent exited with code 1',
				raw: { stderr: 'rate limited', stdout: '' },
			})
		).toBeNull();
		expect(parseAgentErrorEffortRejection(undefined)).toBeNull();
		expect(parseAgentErrorEffortRejection(null)).toBeNull();
	});
});

describe('noteEffortRejection', () => {
	const rejection = { value: 'minimal', model: 'gpt-6-astra', supported: ['low', 'medium'] };

	it('reports a provider and value as new exactly once', () => {
		expect(noteEffortRejection('codex', rejection)).toBe(true);
		expect(noteEffortRejection('codex', rejection)).toBe(false);
		// A second model refusing the same value is the same fact to the resolver.
		expect(noteEffortRejection('codex', { ...rejection, model: 'gpt-6-luna' })).toBe(false);
	});

	it('keeps providers and values apart', () => {
		noteEffortRejection('codex', rejection);
		expect(getEffortRejection('codex', 'minimal')).toEqual(rejection);
		expect(getEffortRejection('codex', 'low')).toBeUndefined();
		expect(getEffortRejection('claude-code', 'minimal')).toBeUndefined();
		expect(noteEffortRejection('claude-code', rejection)).toBe(true);
	});

	it('forgets everything on reset', () => {
		noteEffortRejection('codex', rejection);
		resetEffortRejections();
		expect(getEffortRejection('codex', 'minimal')).toBeUndefined();
	});
});

describe('describeEffortRejection', () => {
	it('names the value, the model, and what is accepted', () => {
		expect(
			describeEffortRejection('Codex', {
				value: 'minimal',
				model: 'gpt-6-astra',
				supported: ['low', 'medium', 'high'],
			})
		).toBe('Codex rejected effort "minimal" for gpt-6-astra. It accepts low, medium, high.');
	});

	it('leaves out what the provider did not say', () => {
		expect(describeEffortRejection('codex', { value: 'minimal', supported: [] })).toBe(
			'codex rejected effort "minimal".'
		);
	});
});
