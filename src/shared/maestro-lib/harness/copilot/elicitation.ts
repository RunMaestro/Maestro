import type {
	ElicitationContext,
	ElicitationFieldValue,
	ElicitationResult,
	ElicitationSchemaField,
} from '@github/copilot-sdk';
import type {
	HarnessInteractionQuestion,
	HarnessInteractionResolution,
} from '../../../harness-control/types';

const INVALID = Symbol('invalid-elicitation');

/** Enforce enum/oneOf choices before accepting any string answer. */
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

/** Apply string choice, length, and format constraints from the provider schema. */
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

/** Convert schema defaults to the string-based answers used by the shared prompt contract. */
function defaultAnswer(field: ElicitationSchemaField): string | string[] | undefined {
	const value = field.default;
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
	return undefined;
}

/** Empty strings and arrays stay distinct from unanswered only when the schema permits them. */
function allowsEmpty(field: ElicitationSchemaField): boolean {
	if (field.type === 'array') return field.minItems === undefined || field.minItems === 0;
	if (field.type === 'string') return validString(field, '');
	return false;
}

/** Translate the provider schema without losing optionality, defaults, or field guidance. */
export function copilotElicitationQuestions(
	request: ElicitationContext
): HarnessInteractionQuestion[] {
	const required = new Set(request.requestedSchema?.required ?? []);
	return Object.entries(request.requestedSchema?.properties ?? {}).map(([id, field]) => {
		const choices =
			'enum' in field && Array.isArray(field.enum)
				? field.enum
				: 'oneOf' in field && Array.isArray(field.oneOf)
					? field.oneOf.map((item) => item.const)
					: field.type === 'boolean'
						? ['true', 'false']
						: field.type === 'array' && 'enum' in field.items
							? field.items.enum
							: field.type === 'array' && 'anyOf' in field.items
								? field.items.anyOf.map((item) => item.const)
								: [];
		const defaultValue = defaultAnswer(field);
		return {
			id,
			question: field.title ?? id,
			description: field.description,
			required: required.has(id),
			...(defaultValue !== undefined ? { default: defaultValue } : {}),
			multiSelect: field.type === 'array',
			allowCustom: choices.length === 0,
			allowEmpty: allowsEmpty(field),
			options: choices.map((choice, index) => ({
				optionId: `choice-${index}`,
				label: choice,
				kind: 'choice' as const,
			})),
		};
	});
}

/** Coerce one answer to its schema type, rejecting blanks and invalid provider content. */
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
		if (typeof answer === 'boolean') return answer;
		return answer === 'true' ? true : answer === 'false' ? false : INVALID;
	}
	if (field.type === 'number' || field.type === 'integer') {
		if (typeof answer === 'string' ? answer.trim() === '' : typeof answer !== 'number') {
			return INVALID;
		}
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
