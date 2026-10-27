import type {
	HarnessControlCapabilities,
	HarnessInteractionOption,
	HarnessInteractionQuestion,
	HarnessInteractionRequest,
	HarnessInteractionResponse,
} from './types';

const PROTOCOLS: Record<string, true> = {
	acp: true,
	'codex-app-server': true,
	'opencode-http': true,
	'claude-sdk': true,
	'copilot-sdk': true,
	'hermes-gateway': true,
	'pi-rpc': true,
	'omp-rpc': true,
	'droid-jsonrpc': true,
	'antigravity-sdk': true,
	legacy: true,
};
const OPTION_KINDS: Record<string, true> = {
	'allow-once': true,
	'allow-always': true,
	'reject-once': true,
	'reject-always': true,
	choice: true,
	other: true,
};
const STEERING: Record<string, true> = { 'in-turn': true, 'follow-up': true, none: true };
const INTERACTION_KINDS: Record<string, true> = {
	permission: true,
	question: true,
	elicitation: true,
};
const CANCEL_REASONS: Record<string, true> = {
	cancelled: true,
	timeout: true,
	'process-exited': true,
	superseded: true,
	'owner-unavailable': true,
	withdrawn: true,
	'transport-closed': true,
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function hasValidOptionalStrings(raw: Record<string, unknown>, keys: string[]): boolean {
	return keys.every((key) => raw[key] === undefined || typeof raw[key] === 'string');
}

function hasValidOptionalBooleans(raw: Record<string, unknown>, keys: string[]): boolean {
	return keys.every((key) => raw[key] === undefined || typeof raw[key] === 'boolean');
}

function hasValidDefault(raw: Record<string, unknown>): boolean {
	return (
		raw.default === undefined ||
		typeof raw.default === 'string' ||
		(Array.isArray(raw.default) && raw.default.every((item) => typeof item === 'string'))
	);
}

function parseOptions(raw: unknown): HarnessInteractionOption[] | null {
	if (!Array.isArray(raw)) return null;
	const options: HarnessInteractionOption[] = [];
	const ids = new Set<string>();
	for (const value of raw) {
		if (!isObject(value)) return null;
		if (
			!isNonEmptyString(value.optionId) ||
			!isNonEmptyString(value.label) ||
			typeof value.kind !== 'string' ||
			OPTION_KINDS[value.kind] !== true ||
			ids.has(value.optionId) ||
			!hasValidOptionalStrings(value, ['description'])
		) {
			return null;
		}
		ids.add(value.optionId);
		const option: HarnessInteractionOption = {
			optionId: value.optionId,
			label: value.label,
			kind: value.kind as HarnessInteractionOption['kind'],
		};
		if (typeof value.description === 'string') option.description = value.description;
		options.push(option);
	}
	return options;
}

function parseQuestions(raw: unknown): HarnessInteractionQuestion[] | null | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) return null;
	const questions: HarnessInteractionQuestion[] = [];
	const ids = new Set<string>();
	for (const value of raw) {
		if (!isObject(value)) return null;
		if (
			!isNonEmptyString(value.id) ||
			!isNonEmptyString(value.question) ||
			ids.has(value.id) ||
			!hasValidOptionalStrings(value, ['header', 'description']) ||
			!hasValidOptionalBooleans(value, [
				'multiSelect',
				'secret',
				'allowCustom',
				'allowEmpty',
				'required',
			]) ||
			!hasValidDefault(value)
		) {
			return null;
		}
		const options = parseOptions(value.options);
		if (!options) return null;
		ids.add(value.id);
		const question: HarnessInteractionQuestion = {
			id: value.id,
			question: value.question,
			options,
		};
		if (typeof value.header === 'string') question.header = value.header;
		if (typeof value.description === 'string') question.description = value.description;
		if (typeof value.required === 'boolean') question.required = value.required;
		if (typeof value.default === 'string') question.default = value.default;
		if (Array.isArray(value.default)) question.default = [...value.default];
		if (typeof value.multiSelect === 'boolean') question.multiSelect = value.multiSelect;
		if (typeof value.allowCustom === 'boolean') question.allowCustom = value.allowCustom;
		if (typeof value.allowEmpty === 'boolean') question.allowEmpty = value.allowEmpty;
		if (typeof value.secret === 'boolean') question.secret = value.secret;
		questions.push(question);
	}
	return questions;
}

/** Validate negotiated adapter capabilities without accepting unknown protocol modes. */
export function parseHarnessControlCapabilities(raw: unknown): HarnessControlCapabilities | null {
	if (!isObject(raw)) return null;
	if (
		typeof raw.protocol !== 'string' ||
		PROTOCOLS[raw.protocol] !== true ||
		!isNonEmptyString(raw.protocolVersion) ||
		typeof raw.steering !== 'string' ||
		STEERING[raw.steering] !== true ||
		!hasValidOptionalStrings(raw, ['agentVersion']) ||
		!hasValidOptionalBooleans(raw, [
			'permissionRequests',
			'questions',
			'elicitations',
			'modelSwitch',
			'modeSwitch',
			'imagePrompts',
			'resume',
		])
	) {
		return null;
	}
	const requiredBooleans = [
		'permissionRequests',
		'questions',
		'elicitations',
		'modelSwitch',
		'modeSwitch',
		'imagePrompts',
		'resume',
	];
	if (requiredBooleans.some((key) => typeof raw[key] !== 'boolean')) return null;
	const capabilities: HarnessControlCapabilities = {
		protocol: raw.protocol as HarnessControlCapabilities['protocol'],
		protocolVersion: raw.protocolVersion,
		steering: raw.steering as HarnessControlCapabilities['steering'],
		permissionRequests: raw.permissionRequests as boolean,
		questions: raw.questions as boolean,
		elicitations: raw.elicitations as boolean,
		modelSwitch: raw.modelSwitch as boolean,
		modeSwitch: raw.modeSwitch as boolean,
		imagePrompts: raw.imagePrompts as boolean,
		resume: raw.resume as boolean,
	};
	if (typeof raw.agentVersion === 'string') capabilities.agentVersion = raw.agentVersion;
	return capabilities;
}

/** Parse an untrusted interaction request, including scoped options and elicitation fields. */
export function parseHarnessInteractionRequest(raw: unknown): HarnessInteractionRequest | null {
	if (!isObject(raw)) return null;
	if (
		!isNonEmptyString(raw.requestId) ||
		!isNonEmptyString(raw.sessionId) ||
		typeof raw.spawnGeneration !== 'number' ||
		!Number.isSafeInteger(raw.spawnGeneration) ||
		raw.spawnGeneration < 1 ||
		typeof raw.kind !== 'string' ||
		INTERACTION_KINDS[raw.kind] !== true ||
		!isNonEmptyString(raw.provider) ||
		!isNonEmptyString(raw.title) ||
		typeof raw.createdAt !== 'number' ||
		!Number.isFinite(raw.createdAt) ||
		!hasValidOptionalStrings(raw, ['tabId', 'turnId', 'toolCallId', 'detail', 'toolName']) ||
		!hasValidOptionalBooleans(raw, ['secret']) ||
		(raw.input !== undefined && !isObject(raw.input))
	) {
		return null;
	}
	const options = parseOptions(raw.options);
	if (!options || (raw.kind === 'permission' && options.length === 0)) return null;
	const questions = parseQuestions(raw.questions);
	if (questions === null) return null;
	const request: HarnessInteractionRequest = {
		requestId: raw.requestId,
		sessionId: raw.sessionId,
		spawnGeneration: raw.spawnGeneration,
		kind: raw.kind as HarnessInteractionRequest['kind'],
		provider: raw.provider,
		title: raw.title,
		options,
		createdAt: raw.createdAt,
	};
	for (const key of ['tabId', 'turnId', 'toolCallId', 'detail', 'toolName'] as const) {
		if (typeof raw[key] === 'string') request[key] = raw[key];
	}
	if (isObject(raw.input)) request.input = { ...raw.input };
	if (questions) request.questions = questions;
	if (typeof raw.secret === 'boolean') request.secret = raw.secret;
	return request;
}

/** Parse a user decision while rejecting malformed or approval-shaped answer payloads. */
export function parseHarnessInteractionResponse(raw: unknown): HarnessInteractionResponse | null {
	if (!isObject(raw) || !isNonEmptyString(raw.requestId)) return null;
	if (raw.outcome === 'selected' && isNonEmptyString(raw.optionId)) {
		return { requestId: raw.requestId, outcome: 'selected', optionId: raw.optionId };
	}
	if (
		raw.outcome === 'cancelled' &&
		typeof raw.reason === 'string' &&
		CANCEL_REASONS[raw.reason] === true
	) {
		return {
			requestId: raw.requestId,
			outcome: 'cancelled',
			reason: raw.reason as Extract<HarnessInteractionResponse, { outcome: 'cancelled' }>['reason'],
		};
	}
	if (raw.outcome === 'answers' && isObject(raw.answers)) {
		const answers: Record<string, string | string[]> = {};
		for (const [key, value] of Object.entries(raw.answers)) {
			if (
				typeof value !== 'string' &&
				(!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
			) {
				return null;
			}
			answers[key] = Array.isArray(value) ? [...value] : value;
		}
		return { requestId: raw.requestId, outcome: 'answers', answers };
	}
	return null;
}
