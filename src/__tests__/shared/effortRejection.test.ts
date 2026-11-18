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

describe('Grok effort refusal diagnostics', () => {
	it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])(
		'reads native %s refusals from raw and escaped JSON without inventing a model',
		(value) => {
			const message = `--effort/--reasoning-effort: unknown effort level '${value}'; use one of: balanced-v2, careful.reasoner`;
			const expected = { value, supported: ['balanced-v2', 'careful.reasoner'] };
			expect(parseEffortRejection(message)).toEqual(expected);
			expect(parseEffortRejection(`progress\n${message}\nnext diagnostic`)).toEqual(expected);
			expect(parseEffortRejection(JSON.stringify({ type: 'error', message }))).toEqual(expected);
			expect(
				parseEffortRejection(JSON.stringify({ message: JSON.stringify({ message }) }))
			).toEqual(expected);
			// Another JSON wrapper makes the menu delimiters ambiguous.
			expect(
				parseEffortRejection(
					JSON.stringify({ message: JSON.stringify({ message: JSON.stringify({ message }) }) })
				)
			).toEqual({ value, supported: [] });
		}
	);

	it('keeps an empty-menu refusal without fabricating accepted values', () => {
		const message =
			"--effort/--reasoning-effort: unknown effort level 'HIGH'; this model has no selectable effort levels";
		const expected = { value: 'HIGH', supported: [] };
		expect(parseEffortRejection(message)).toEqual(expected);
		expect(parseEffortRejection(`${message}\nnext diagnostic`)).toEqual(expected);
		expect(parseEffortRejection(JSON.stringify({ type: 'error', message }))).toEqual(expected);
	});

	it('retains the rejected value when quoted menu IDs cannot be read unambiguously', () => {
		const message =
			'--effort/--reasoning-effort: unknown effort level \'max\'; use one of: "careful", balanced';
		expect(parseEffortRejection(JSON.stringify({ message }))).toEqual({
			value: 'max',
			supported: [],
		});
	});

	it.each([
		"unknown effort level 'max'; use one of: low, high",
		"--effort/--reasoning-effort: unknown effort level 'careful' (model catalog unavailable; remapped menu ids require a loaded catalog)",
		'--effort/--reasoning-effort: no active model to apply effort to',
		'--effort/--reasoning-effort: model does not support reasoning effort; ignoring',
		'unknown reasoning_effort value',
		'unknown reasoning_effort value: max',
		"--effort/--reasoning-effort: unknown effort level 'max'",
		"--effort/--reasoning-effort: unknown effort level 'max'; this model has no selectable effort levels yet",
	])('does not guess a model refusal from %s', (message) => {
		expect(parseEffortRejection(message)).toBeNull();
		expect(parseEffortRejection(JSON.stringify({ type: 'error', message }))).toBeNull();
	});

	it.each(['errorLine', 'stderr', 'stdout'] as const)(
		'recovers the native diagnostic from AgentError raw.%s',
		(field) => {
			const message =
				"--effort/--reasoning-effort: unknown effort level 'minimal'; use one of: low, high";
			expect(
				parseAgentErrorEffortRejection({
					message: 'Agent exited with code 1',
					raw: { [field]: JSON.stringify({ type: 'error', message }) },
				})
			).toEqual({ value: 'minimal', supported: ['low', 'high'] });
		}
	);

	it('keeps the primary native refusal ahead of a different raw diagnostic', () => {
		expect(
			parseAgentErrorEffortRejection({
				message: "--effort/--reasoning-effort: unknown effort level 'max'; use one of: low, medium",
				raw: { errorLine: AGENT_ERROR_MESSAGE, stderr: JSONL_LINE },
			})
		).toEqual({ value: 'max', supported: ['low', 'medium'] });
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

	it('deduplicates Grok ASCII case across models while retaining the original diagnostic', () => {
		const original = { value: 'HIGH', model: 'grok-model-a', supported: ['balanced-v2'] };
		expect(noteEffortRejection('grok', original)).toBe(true);
		expect(
			noteEffortRejection('grok', { value: 'high', model: 'grok-model-b', supported: [] })
		).toBe(false);
		expect(getEffortRejection('grok', 'HiGh')).toEqual(original);
		expect(getEffortRejection('grok', 'balanced-v2')).toBeUndefined();
		expect(getEffortRejection('grok', 'max')).toBeUndefined();
		expect(getEffortRejection('codex', 'HIGH')).toBeUndefined();
		expect(noteEffortRejection('codex', original)).toBe(true);
		expect(getEffortRejection('codex', 'high')).toBeUndefined();
		expect(getEffortRejection('codex', 'HIGH')).toEqual(original);
		resetEffortRejections();
		expect(getEffortRejection('grok', 'high')).toBeUndefined();
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
