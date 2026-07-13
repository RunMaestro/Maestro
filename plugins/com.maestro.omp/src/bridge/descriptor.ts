import { MAX_OMP_IMAGE_BYTES, MAX_OMP_PROMPT_ATTACHMENT_BYTES } from '../runtime/byte-codec';

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
	| 'omp.session.rename'
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
const MAX_ATTACHMENT_BYTES_PER_FILE = MAX_OMP_IMAGE_BYTES;
const MAX_ATTACHMENT_TOTAL_BYTES = MAX_OMP_PROMPT_ATTACHMENT_BYTES;
const SUPPORTED_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
const attachmentSchema: JsonSchema = objectSchema(
	{
		ref: stringSchema(36, 36),
		name: stringSchema(1, 255),
		mediaType: { enum: SUPPORTED_IMAGE_MEDIA_TYPES },
		size: integerSchema(1, MAX_ATTACHMENT_BYTES_PER_FILE),
		sha256: stringSchema(64, 64),
	},
	['ref', 'name', 'mediaType', 'size', 'sha256']
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
const renameSchema: JsonSchema = objectSchema(
	{ sessionId: stringSchema(1, 4096), name: stringSchema(1, 4096) },
	['sessionId', 'name']
);
const loginSchema: JsonSchema = objectSchema({ providerId: stringSchema(1) }, ['providerId']);
const exportSchema: JsonSchema = objectSchema({ sessionId: stringSchema(1) }, ['sessionId']);
const ackSchema: JsonSchema = objectSchema({});
const nonNegativeIntegerSchema: JsonSchema = integerSchema(0, Number.MAX_SAFE_INTEGER);
const messageSummarySchema: JsonSchema = objectSchema(
	{
		id: stringSchema(1, 256),
		role: { enum: ['user', 'assistant', 'system', 'tool', 'other'] },
		text: stringSchema(0, 65536),
	},
	['id', 'role', 'text']
);
const todoPhaseSchema: JsonSchema = objectSchema({
	id: stringSchema(0, 256),
	label: stringSchema(0, 65536),
	status: stringSchema(0, 128),
});
const treeNodeSchema: JsonSchema = objectSchema(
	{
		id: stringSchema(1, 256),
		label: stringSchema(0, 65536),
		children: { type: 'array', maxItems: 500 },
	},
	['id', 'label']
);
const workspaceSessionSchema: JsonSchema = objectSchema(
	{
		id: stringSchema(0, 4096),
		title: stringSchema(0, 4096),
		updatedAt: nonNegativeIntegerSchema,
		status: { enum: ['idle', 'streaming', 'queued', 'waiting-approval', 'error'] },
		model: stringSchema(0, 4096),
		mode: { enum: ['build', 'plan', 'ask'] },
		events: { type: 'array', maxItems: 0 },
		tree: { type: 'array', maxItems: 500, items: treeNodeSchema },
		subagents: { type: 'array', maxItems: 0 },
		usage: objectSchema(
			{ inputTokens: nonNegativeIntegerSchema, outputTokens: nonNegativeIntegerSchema },
			['inputTokens', 'outputTokens']
		),
		thinkingLevel: { enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
		queuedMessageCount: nonNegativeIntegerSchema,
		todoPhases: { type: 'array', maxItems: 500, items: todoPhaseSchema },
	},
	[
		'id',
		'title',
		'updatedAt',
		'status',
		'model',
		'mode',
		'events',
		'tree',
		'subagents',
		'usage',
		'queuedMessageCount',
		'todoPhases',
	]
);
const workspaceSnapshotSchema: JsonSchema = objectSchema(
	{
		connection: { enum: ['loading', 'ready', 'offline', 'error'] },
		models: { type: 'array', maxItems: 100, items: stringSchema(1, 4096) },
		sessions: { type: 'array', maxItems: 100, items: workspaceSessionSchema },
		activeSessionId: stringSchema(0, 4096),
		error: stringSchema(0, 4096),
	},
	['connection', 'models', 'sessions', 'activeSessionId']
);
const messageLoadResultSchema: JsonSchema = objectSchema(
	{ messages: { type: 'array', maxItems: 500, items: messageSummarySchema } },
	['messages']
);
const statsResultSchema: JsonSchema = objectSchema(
	{ messageCount: nonNegativeIntegerSchema, queuedMessageCount: nonNegativeIntegerSchema },
	['messageCount', 'queuedMessageCount']
);
const subagentEntrySchema: JsonSchema = objectSchema(
	{
		id: stringSchema(1, 256),
		label: stringSchema(0, 65536),
		status: stringSchema(0, 128),
	},
	['id', 'label', 'status']
);
const subagentMessagesResultSchema: JsonSchema = objectSchema(
	{
		fromByte: nonNegativeIntegerSchema,
		nextByte: nonNegativeIntegerSchema,
		reset: { enum: [true, false] },
		entries: { type: 'array', maxItems: 500, items: subagentEntrySchema },
		messages: { type: 'array', maxItems: 500, items: messageSummarySchema },
	},
	['fromByte', 'nextByte', 'reset', 'entries', 'messages']
);
const authProvidersResultSchema: JsonSchema = objectSchema(
	{
		providers: {
			type: 'array',
			maxItems: 100,
			items: objectSchema(
				{
					id: stringSchema(1, 256),
					name: stringSchema(1, 256),
					available: { enum: [true, false] },
					authenticated: { enum: [true, false] },
				},
				['id', 'name', 'available', 'authenticated']
			),
		},
	},
	['providers']
);
const authLoginResultSchema: JsonSchema = objectSchema({ providerId: stringSchema(1, 4096) }, [
	'providerId',
]);
const exportResultSchema: JsonSchema = objectSchema({ path: stringSchema(1, 4096) }, ['path']);
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
		'omp.session.rename': { canonicalJsonSchema: renameSchema },
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
		'omp.view.replace': { canonicalJsonSchema: workspaceSnapshotSchema },
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
		'omp.session.create': { canonicalJsonSchema: workspaceSnapshotSchema },
		'omp.session.select': { canonicalJsonSchema: workspaceSnapshotSchema },
		'omp.prompt.send': { canonicalJsonSchema: ackSchema },
		'omp.steer.send': { canonicalJsonSchema: ackSchema },
		'omp.followUp.send': { canonicalJsonSchema: ackSchema },
		'omp.run.abort': { canonicalJsonSchema: ackSchema },
		'omp.run.abortAndPrompt': { canonicalJsonSchema: ackSchema },
		'omp.session.compact': { canonicalJsonSchema: workspaceSnapshotSchema },
		'omp.session.branch': { canonicalJsonSchema: workspaceSnapshotSchema },
		'omp.session.handoff': { canonicalJsonSchema: workspaceSnapshotSchema },
		'omp.session.rename': { canonicalJsonSchema: workspaceSnapshotSchema },
		'omp.model.set': { canonicalJsonSchema: workspaceSnapshotSchema },
		'omp.model.cycle': { canonicalJsonSchema: workspaceSnapshotSchema },
		'omp.composer.mode.set': { canonicalJsonSchema: workspaceSnapshotSchema },
		'omp.approval.resolve': { canonicalJsonSchema: ackSchema },
		'omp.thinking.set': { canonicalJsonSchema: workspaceSnapshotSchema },
		'omp.thinking.cycle': { canonicalJsonSchema: workspaceSnapshotSchema },
		'omp.settings.set': { canonicalJsonSchema: workspaceSnapshotSchema },
		'omp.commands.refresh': { canonicalJsonSchema: workspaceSnapshotSchema },
		'omp.messages.load': { canonicalJsonSchema: messageLoadResultSchema },
		'omp.stats.load': { canonicalJsonSchema: statsResultSchema },
		'omp.subagents.load': { canonicalJsonSchema: subagentMessagesResultSchema },
		'omp.auth.providers': { canonicalJsonSchema: authProvidersResultSchema },
		'omp.auth.login': { canonicalJsonSchema: authLoginResultSchema },
		'omp.export.request': { canonicalJsonSchema: exportResultSchema },
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
		'omp.session.rename': { canonicalJsonSchema: errorSchema },
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
		const { ref, name, mediaType, size, sha256 } = attachment;
		if (
			typeof ref !== 'string' ||
			!isUuid(ref) ||
			typeof name !== 'string' ||
			name.length === 0 ||
			name.includes('/') ||
			name.includes('\\') ||
			[...name].some((character) => character.charCodeAt(0) < 32) ||
			typeof mediaType !== 'string' ||
			!(SUPPORTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType) ||
			typeof size !== 'number' ||
			!Number.isInteger(size) ||
			size < 1 ||
			size > MAX_ATTACHMENT_BYTES_PER_FILE ||
			typeof sha256 !== 'string' ||
			!/^[a-f0-9]{64}$/.test(sha256)
		)
			return false;
		totalBytes += size;
		if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) return false;
	}
	return true;
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
	if (Array.isArray(schema.anyOf)) {
		return schema.anyOf.some((entry) => validateSchema(entry as JsonSchema, value));
	}
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
