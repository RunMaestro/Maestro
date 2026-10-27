import type {
	ElicitationContext,
	ElicitationFieldValue,
	ElicitationResult,
	ElicitationSchemaField,
} from '@github/copilot-sdk';
import type { HarnessInteractionResolution } from '../../../harness-control/types';

const INVALID = Symbol('invalid-elicitation');

function choiceAllowed(field: ElicitationSchemaField, value: string): boolean {
	if ('enum' in field && Array.isArray(field.enum) && !field.enum.includes(value)) return false;
	if (
		'oneOf' in field &&
		Array.isArray(field.oneOf) &&
		!field.oneOf.some((item) => item.const === value)
	) {
		return false;
	}
	return true;
}

function validString(field: ElicitationSchemaField, value: string): boolean {
	if (!choiceAllowed(field, value)) return false;
	if ('minLength' in field && field.minLength !== undefined && value.length < field.minLength) {
		return false;
	}
	if ('maxLength' in field && field.maxLength !== undefined && value.length > field.maxLength) {
		return false;
	}
	if ('format' in field) {
		if (field.format === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return false;
		if (field.format === 'uri') {
			try {
				new URL(value);
			} catch {
				return false;
			}
		}
		if (field.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
		if (field.format === 'date-time' && !Number.isFinite(Date.parse(value))) return false;
	}
	return true;
}

function coerce(
	field: ElicitationSchemaField,
	answer: unknown
): ElicitationFieldValue | typeof INVALID {
	if (field.type === 'array') {
		if (!Array.isArray(answer) || answer.some((item) => typeof item !== 'string')) return INVALID;
		if (field.minItems !== undefined && answer.length < field.minItems) return INVALID;
		if (field.maxItems !== undefined && answer.length > field.maxItems) return INVALID;
		const itemSchema = field.items;
		if ('enum' in itemSchema && answer.some((item) => !itemSchema.enum.includes(item))) {
			return INVALID;
		}
		if (
			'anyOf' in itemSchema &&
			answer.some((item) => !itemSchema.anyOf.some((option) => option.const === item))
		) {
			return INVALID;
		}
		return answer;
	}
	if (field.type === 'boolean') {
		return answer === 'true' ? true : answer === 'false' ? false : INVALID;
	}
	if (field.type === 'number' || field.type === 'integer') {
		const value = Number(answer);
		if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value))) {
			return INVALID;
		}
		if (field.minimum !== undefined && value < field.minimum) return INVALID;
		if (field.maximum !== undefined && value > field.maximum) return INVALID;
		return value;
	}
	if (typeof answer !== 'string' || !validString(field, answer)) return INVALID;
	return answer;
}

/** Convert broker answers without inventing optional values or accepting invalid schema content. */
export function copilotElicitationResult(
	request: ElicitationContext,
	resolution: HarnessInteractionResolution
): ElicitationResult {
	if (resolution.outcome !== 'answers') return { action: 'decline' };
	const properties = request.requestedSchema?.properties ?? {};
	const required = new Set(request.requestedSchema?.required ?? []);
	const content: Record<string, ElicitationFieldValue> = {};
	for (const [id, field] of Object.entries(properties)) {
		const answer = resolution.answers[id];
		if (answer === undefined) {
			if (field.default !== undefined) {
				const value = coerce(field, field.default);
				if (value === INVALID) return { action: 'decline' };
				content[id] = value;
			} else if (required.has(id)) {
				return { action: 'decline' };
			}
			continue;
		}
		const value = coerce(field, answer);
		if (value === INVALID) return { action: 'decline' };
		content[id] = value;
	}
	return { action: 'accept', content };
}
