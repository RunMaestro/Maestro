import { DeliveryPlannerValidationError } from './planner-service';

export interface DeliveryPlannerStructuredTask {
	title: string;
	description?: string;
	acceptanceCriteria?: string[];
	filesLikelyTouched?: string[];
	dependsOnTaskTitles?: string[];
	integrationRisks?: string[];
	parallel?: boolean;
	tags?: string[];
	capabilities?: string[];
	priority?: number;
}

export interface DeliveryPlannerStructuredDecomposition {
	tasks: DeliveryPlannerStructuredTask[];
}

export function parseDeliveryPlannerStructuredOutput(
	value: string | unknown
): DeliveryPlannerStructuredDecomposition {
	const parsed = typeof value === 'string' ? parseJsonPayload(value) : value;
	if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) {
		throw new DeliveryPlannerValidationError(
			'Delivery Planner structured output must include a tasks array'
		);
	}

	return {
		tasks: parsed.tasks.map(normalizeTask),
	};
}

function parseJsonPayload(value: string): unknown {
	const trimmed = value.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const payload = fenced?.[1] ?? trimmed;

	try {
		return JSON.parse(payload);
	} catch {
		throw new DeliveryPlannerValidationError(
			'Delivery Planner structured output must be valid JSON'
		);
	}
}

function normalizeTask(value: unknown, index: number): DeliveryPlannerStructuredTask {
	if (!isRecord(value)) {
		throw new DeliveryPlannerValidationError(`Decomposed task ${index + 1} must be an object`);
	}

	const title = readString(value.title);
	if (!title) {
		throw new DeliveryPlannerValidationError(`Decomposed task ${index + 1} is missing a title`);
	}

	return {
		title,
		description: readString(value.description),
		acceptanceCriteria: readStringArray(value.acceptanceCriteria),
		filesLikelyTouched: readStringArray(value.filesLikelyTouched),
		dependsOnTaskTitles: readStringArray(value.dependsOnTaskTitles),
		integrationRisks: readStringArray(value.integrationRisks),
		parallel: typeof value.parallel === 'boolean' ? value.parallel : undefined,
		tags: readStringArray(value.tags),
		capabilities: readStringArray(value.capabilities),
		priority: typeof value.priority === 'number' ? value.priority : undefined,
	};
}

function readString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const strings = value.map(readString).filter((item): item is string => Boolean(item));
	return strings.length ? strings : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
