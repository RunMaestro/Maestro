export type OmpPanelRequestKind =
	| 'omp.session.create'
	| 'omp.session.select'
	| 'omp.prompt.send'
	| 'omp.steer.send'
	| 'omp.followUp.send'
	| 'omp.run.abort'
	| 'omp.run.abortAndPrompt'
	| 'omp.session.compact'
	| 'omp.session.branch'
	| 'omp.session.handoff'
	| 'omp.model.set'
	| 'omp.model.cycle'
	| 'omp.composer.mode.set'
	| 'omp.approval.resolve'
	| 'omp.thinking.set'
	| 'omp.thinking.cycle'
	| 'omp.settings.set'
	| 'omp.commands.refresh'
	| 'omp.messages.load'
	| 'omp.stats.load'
	| 'omp.subagents.load'
	| 'omp.auth.providers'
	| 'omp.auth.login'
	| 'omp.export.request';

export type OmpPanelEventKind =
	| 'omp.view.replace'
	| 'omp.stream.delta'
	| 'omp.approval.required'
	| 'omp.auth.progress'
	| 'omp.panel.focusComposer'
	| 'omp.panel.focusSession';

type JsonSchema = Record<string, unknown>;
type SchemaEntry = { readonly canonicalJsonSchema: JsonSchema };

export interface ClosedPanelBridge {
	readonly requestSchemas: Readonly<Record<OmpPanelRequestKind, SchemaEntry>>;
	readonly eventSchemas: Readonly<Record<OmpPanelEventKind, SchemaEntry>>;
	readonly resultSchemas: Readonly<Record<OmpPanelRequestKind, SchemaEntry>>;
	readonly errorSchemas: Readonly<Record<OmpPanelRequestKind, SchemaEntry>>;
}

const emptyObjectSchema: JsonSchema = objectSchema({});
const sessionIdSchema: JsonSchema = objectSchema({ sessionId: stringSchema(1) }, ['sessionId']);
const MAX_ATTACHMENT_BYTES_PER_FILE = 128 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 512 * 1024;
const MAX_ATTACHMENT_BASE64_LENGTH = Math.ceil(MAX_ATTACHMENT_BYTES_PER_FILE / 3) * 4;
const attachmentSchema: JsonSchema = objectSchema(
	{
		name: stringSchema(1, 255),
		mediaType: stringSchema(3, 127),
		size: integerSchema(1, MAX_ATTACHMENT_BYTES_PER_FILE),
		dataBase64: stringSchema(4, MAX_ATTACHMENT_BASE64_LENGTH),
	},
	['name', 'mediaType', 'size', 'dataBase64']
);
const promptSchema: JsonSchema = objectSchema(
	{
		sessionId: stringSchema(1),
		text: stringSchema(1, 65536),
		attachments: { type: 'array', maxItems: 8, items: attachmentSchema },
	},
	['sessionId', 'text', 'attachments']
);
const instructionsSchema: JsonSchema = objectSchema(
	{ sessionId: stringSchema(1), customInstructions: stringSchema(0, 65536) },
	['sessionId']
);
const settingsSchema: JsonSchema = objectSchema(
	{
		sessionId: stringSchema(1),
		setting: {
			enum: [
				'steeringMode',
				'followUpMode',
				'interruptMode',
				'autoCompaction',
				'autoRetry',
				'subagentSubscription',
			],
		},
		value: {},
	},
	['sessionId', 'setting', 'value']
);
const messageLoadSchema: JsonSchema = objectSchema(
	{ sessionId: stringSchema(1), from: integerSchema(0), limit: integerSchema(1, 500) },
	['sessionId']
);
const subagentLoadSchema: JsonSchema = objectSchema(
	{ sessionId: stringSchema(1), subagentId: stringSchema(1), fromByte: integerSchema(0) },
	['sessionId']
);
const modelSchema: JsonSchema = objectSchema(
	{ sessionId: stringSchema(1), provider: stringSchema(1), modelId: stringSchema(1) },
	['sessionId', 'provider', 'modelId']
);
const composerModeSchema: JsonSchema = objectSchema(
	{
		sessionId: stringSchema(1),
		mode: { enum: ['build', 'plan', 'ask'] },
	},
	['sessionId', 'mode']
);
const approvalResolutionSchema: JsonSchema = objectSchema(
	{
		sessionId: stringSchema(1),
		requestId: stringSchema(1),
		approved: { enum: [true, false] },
	},
	['sessionId', 'requestId', 'approved']
);
const thinkingSchema: JsonSchema = objectSchema(
	{
		sessionId: stringSchema(1),
		level: { enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
	},
	['sessionId', 'level']
);
const branchSchema: JsonSchema = objectSchema(
	{ sessionId: stringSchema(1), entryId: stringSchema(1) },
	['sessionId', 'entryId']
);
const loginSchema: JsonSchema = objectSchema({ providerId: stringSchema(1) }, ['providerId']);
const exportSchema: JsonSchema = objectSchema({ sessionId: stringSchema(1) }, ['sessionId']);
const resultSchema: JsonSchema = objectSchema({});
const errorSchema: JsonSchema = objectSchema(
	{
		code: {
			enum: [
				'backpressure',
				'invalid_request',
				'capability_unavailable',
				'policy_denied',
				'runtime_stopped',
				'timeout',
				'cancelled',
			],
		},
		message: stringSchema(1),
	},
	['code', 'message']
);

/** §4.2 single source of truth. It exposes only named protocol actions, never a raw command tunnel. */
export const OMP_PANEL_BRIDGE_DESCRIPTOR: ClosedPanelBridge = {
	requestSchemas: {
		'omp.session.create': { canonicalJsonSchema: emptyObjectSchema },
		'omp.session.select': { canonicalJsonSchema: sessionIdSchema },
		'omp.prompt.send': { canonicalJsonSchema: promptSchema },
		'omp.steer.send': { canonicalJsonSchema: promptSchema },
		'omp.followUp.send': { canonicalJsonSchema: promptSchema },
		'omp.run.abort': { canonicalJsonSchema: sessionIdSchema },
		'omp.run.abortAndPrompt': { canonicalJsonSchema: promptSchema },
		'omp.session.compact': { canonicalJsonSchema: instructionsSchema },
		'omp.session.branch': { canonicalJsonSchema: branchSchema },
		'omp.session.handoff': { canonicalJsonSchema: instructionsSchema },
		'omp.model.set': { canonicalJsonSchema: modelSchema },
		'omp.model.cycle': { canonicalJsonSchema: sessionIdSchema },
		'omp.composer.mode.set': { canonicalJsonSchema: composerModeSchema },
		'omp.approval.resolve': { canonicalJsonSchema: approvalResolutionSchema },
		'omp.thinking.set': { canonicalJsonSchema: thinkingSchema },
		'omp.thinking.cycle': { canonicalJsonSchema: sessionIdSchema },
		'omp.settings.set': { canonicalJsonSchema: settingsSchema },
		'omp.commands.refresh': { canonicalJsonSchema: emptyObjectSchema },
		'omp.messages.load': { canonicalJsonSchema: messageLoadSchema },
		'omp.stats.load': { canonicalJsonSchema: sessionIdSchema },
		'omp.subagents.load': { canonicalJsonSchema: subagentLoadSchema },
		'omp.auth.providers': { canonicalJsonSchema: emptyObjectSchema },
		'omp.auth.login': { canonicalJsonSchema: loginSchema },
		'omp.export.request': { canonicalJsonSchema: exportSchema },
	},
	eventSchemas: {
		'omp.view.replace': { canonicalJsonSchema: { type: 'object' } },
		'omp.stream.delta': {
			canonicalJsonSchema: objectSchema(
				{ sessionId: stringSchema(1), delta: stringSchema(0, 65536) },
				['sessionId', 'delta']
			),
		},
		'omp.approval.required': {
			canonicalJsonSchema: objectSchema(
				{
					sessionId: stringSchema(1),
					requestId: stringSchema(1),
					description: stringSchema(1, 65536),
				},
				['sessionId', 'requestId']
			),
		},
		'omp.auth.progress': {
			canonicalJsonSchema: objectSchema(
				{
					transactionId: stringSchema(1),
					phase: { enum: ['opening', 'waiting', 'complete', 'failed'] },
				},
				['transactionId', 'phase']
			),
		},
		'omp.panel.focusComposer': { canonicalJsonSchema: emptyObjectSchema },
		'omp.panel.focusSession': { canonicalJsonSchema: sessionIdSchema },
	},
	resultSchemas: {
		'omp.session.create': { canonicalJsonSchema: resultSchema },
		'omp.session.select': { canonicalJsonSchema: resultSchema },
		'omp.prompt.send': { canonicalJsonSchema: resultSchema },
		'omp.steer.send': { canonicalJsonSchema: resultSchema },
		'omp.followUp.send': { canonicalJsonSchema: resultSchema },
		'omp.run.abort': { canonicalJsonSchema: resultSchema },
		'omp.run.abortAndPrompt': { canonicalJsonSchema: resultSchema },
		'omp.session.compact': { canonicalJsonSchema: resultSchema },
		'omp.session.branch': { canonicalJsonSchema: resultSchema },
		'omp.session.handoff': { canonicalJsonSchema: resultSchema },
		'omp.model.set': { canonicalJsonSchema: resultSchema },
		'omp.model.cycle': { canonicalJsonSchema: resultSchema },
		'omp.composer.mode.set': { canonicalJsonSchema: resultSchema },
		'omp.approval.resolve': { canonicalJsonSchema: resultSchema },
		'omp.thinking.set': { canonicalJsonSchema: resultSchema },
		'omp.thinking.cycle': { canonicalJsonSchema: resultSchema },
		'omp.settings.set': { canonicalJsonSchema: resultSchema },
		'omp.commands.refresh': { canonicalJsonSchema: resultSchema },
		'omp.messages.load': { canonicalJsonSchema: resultSchema },
		'omp.stats.load': { canonicalJsonSchema: resultSchema },
		'omp.subagents.load': { canonicalJsonSchema: resultSchema },
		'omp.auth.providers': { canonicalJsonSchema: resultSchema },
		'omp.auth.login': { canonicalJsonSchema: resultSchema },
		'omp.export.request': { canonicalJsonSchema: resultSchema },
	},
	errorSchemas: {
		'omp.session.create': { canonicalJsonSchema: errorSchema },
		'omp.session.select': { canonicalJsonSchema: errorSchema },
		'omp.prompt.send': { canonicalJsonSchema: errorSchema },
		'omp.steer.send': { canonicalJsonSchema: errorSchema },
		'omp.followUp.send': { canonicalJsonSchema: errorSchema },
		'omp.run.abort': { canonicalJsonSchema: errorSchema },
		'omp.run.abortAndPrompt': { canonicalJsonSchema: errorSchema },
		'omp.session.compact': { canonicalJsonSchema: errorSchema },
		'omp.session.branch': { canonicalJsonSchema: errorSchema },
		'omp.session.handoff': { canonicalJsonSchema: errorSchema },
		'omp.model.set': { canonicalJsonSchema: errorSchema },
		'omp.model.cycle': { canonicalJsonSchema: errorSchema },
		'omp.composer.mode.set': { canonicalJsonSchema: errorSchema },
		'omp.approval.resolve': { canonicalJsonSchema: errorSchema },
		'omp.thinking.set': { canonicalJsonSchema: errorSchema },
		'omp.thinking.cycle': { canonicalJsonSchema: errorSchema },
		'omp.settings.set': { canonicalJsonSchema: errorSchema },
		'omp.commands.refresh': { canonicalJsonSchema: errorSchema },
		'omp.messages.load': { canonicalJsonSchema: errorSchema },
		'omp.stats.load': { canonicalJsonSchema: errorSchema },
		'omp.subagents.load': { canonicalJsonSchema: errorSchema },
		'omp.auth.providers': { canonicalJsonSchema: errorSchema },
		'omp.auth.login': { canonicalJsonSchema: errorSchema },
		'omp.export.request': { canonicalJsonSchema: errorSchema },
	},
};

export const OMP_PANEL_BRIDGE_DESCRIPTOR_JSON = JSON.stringify(OMP_PANEL_BRIDGE_DESCRIPTOR);

export type OmpBridgeValidation =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: 'unknown_kind' | 'invalid_envelope' };

/** Validates a closed request envelope without accepting coerced values or extra fields. */
export function validateOmpBridgeEnvelope(value: unknown): OmpBridgeValidation {
	if (!isRecord(value) || typeof value.kind !== 'string' || !('payload' in value)) {
		return { ok: false, code: 'invalid_envelope' };
	}
	if (!hasOwn(OMP_PANEL_BRIDGE_DESCRIPTOR.requestSchemas, value.kind)) {
		return { ok: false, code: 'unknown_kind' };
	}
	const kind = value.kind as OmpPanelRequestKind;
	const valid =
		validateSchema(
			OMP_PANEL_BRIDGE_DESCRIPTOR.requestSchemas[kind].canonicalJsonSchema,
			value.payload
		) &&
		(kind !== 'omp.prompt.send' &&
		kind !== 'omp.steer.send' &&
		kind !== 'omp.followUp.send' &&
		kind !== 'omp.run.abortAndPrompt'
			? true
			: isValidPromptAttachments(value.payload));
	return valid ? { ok: true } : { ok: false, code: 'invalid_envelope' };
}

function isValidPromptAttachments(payload: unknown): boolean {
	if (!isRecord(payload) || !Array.isArray(payload.attachments)) return false;
	let totalBytes = 0;
	for (const attachment of payload.attachments) {
		if (!isRecord(attachment)) return false;
		const { name, mediaType, size, dataBase64 } = attachment;
		if (
			typeof name !== 'string' ||
			name.length === 0 ||
			name.includes('/') ||
			name.includes('\\') ||
			[...name].some((character) => character.charCodeAt(0) < 32) ||
			typeof mediaType !== 'string' ||
			!/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(mediaType) ||
			typeof size !== 'number' ||
			!Number.isInteger(size) ||
			size < 1 ||
			size > MAX_ATTACHMENT_BYTES_PER_FILE ||
			typeof dataBase64 !== 'string' ||
			!isBase64(dataBase64) ||
			decodedBase64Length(dataBase64) !== size
		)
			return false;
		totalBytes += size + dataBase64.length;
		if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) return false;
	}
	return true;
}

function isBase64(value: string): boolean {
	return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function decodedBase64Length(value: string): number {
	const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
	return (value.length / 4) * 3 - padding;
}

function objectSchema(
	properties: Record<string, unknown>,
	required: readonly string[] = []
): JsonSchema {
	return {
		type: 'object',
		additionalProperties: false,
		properties,
		...(required.length > 0 ? { required } : {}),
	};
}

function stringSchema(minLength: number, maxLength?: number): JsonSchema {
	return { type: 'string', minLength, ...(maxLength === undefined ? {} : { maxLength }) };
}

function integerSchema(minimum: number, maximum?: number): JsonSchema {
	return { type: 'integer', minimum, ...(maximum === undefined ? {} : { maximum }) };
}

function validateSchema(schema: JsonSchema, value: unknown): boolean {
	if (schema.type === 'object') {
		if (!isRecord(value)) return false;
		const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
		const required = (schema.required ?? []) as readonly string[];
		return (
			required.every((key) => hasOwn(value, key)) &&
			Object.entries(value).every(
				([key, entry]) => hasOwn(properties, key) && validateSchema(properties[key], entry)
			)
		);
	}
	if (schema.type === 'array') {
		const maxItems = schema.maxItems as number | undefined;
		return (
			Array.isArray(value) &&
			(maxItems === undefined || value.length <= maxItems) &&
			value.every((entry) => validateSchema(schema.items as JsonSchema, entry))
		);
	}
	if (schema.type === 'string') {
		const minLength = schema.minLength as number | undefined;
		const maxLength = schema.maxLength as number | undefined;
		return (
			typeof value === 'string' &&
			(minLength === undefined || value.length >= minLength) &&
			(maxLength === undefined || value.length <= maxLength)
		);
	}
	if (schema.type === 'integer') {
		const minimum = schema.minimum as number;
		const maximum = schema.maximum as number | undefined;
		return (
			Number.isInteger(value) &&
			typeof value === 'number' &&
			value >= minimum &&
			(maximum === undefined || value <= maximum)
		);
	}
	if (schema.enum) return (schema.enum as readonly unknown[]).includes(value);
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}
