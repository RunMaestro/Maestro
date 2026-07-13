export type OmpPanelRequestKind =
	| 'omp.workspace.snapshot'
	| 'omp.session.select'
	| 'omp.session.create'
	| 'omp.message.send'
	| 'omp.session.abort'
	| 'omp.session.set-model'
	| 'omp.session.set-mode'
	| 'omp.approval.resolve'
	| 'omp.workspace.retry';

export type OmpPanelEventKind = 'omp.workspace.snapshot';
export type OmpPanelErrorKind = 'omp.panel.error';

type JsonSchema = Record<string, unknown>;

export interface ClosedPanelBridge {
	readonly requestSchemas: Readonly<
		Record<OmpPanelRequestKind, { readonly canonicalJsonSchema: JsonSchema }>
	>;
	readonly eventSchemas: Readonly<
		Record<OmpPanelEventKind, { readonly canonicalJsonSchema: JsonSchema }>
	>;
	readonly resultSchemas: Readonly<
		Record<OmpPanelRequestKind, { readonly canonicalJsonSchema: JsonSchema }>
	>;
	readonly errorSchemas: Readonly<
		Record<OmpPanelErrorKind, { readonly canonicalJsonSchema: JsonSchema }>
	>;
}

const emptyObjectSchema: JsonSchema = {
	type: 'object',
	additionalProperties: false,
	properties: {},
};

const sessionIdSchema: JsonSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['sessionId'],
	properties: { sessionId: { type: 'string', minLength: 1 } },
};

const snapshotSchema: JsonSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['connection', 'models', 'sessions', 'activeSessionId'],
	properties: {
		connection: { enum: ['loading', 'ready', 'offline', 'incompatible', 'error'] },
		models: { type: 'array', items: { type: 'string' } },
		sessions: { type: 'array', items: { type: 'object' } },
		activeSessionId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
		incompatibilityReason: { type: 'string' },
		error: { type: 'string' },
	},
};

/** §4.2 single source of truth, emitted verbatim by artifact packaging. */
export const OMP_PANEL_BRIDGE_DESCRIPTOR: ClosedPanelBridge = {
	requestSchemas: {
		'omp.workspace.snapshot': { canonicalJsonSchema: emptyObjectSchema },
		'omp.session.select': { canonicalJsonSchema: sessionIdSchema },
		'omp.session.create': { canonicalJsonSchema: emptyObjectSchema },
		'omp.message.send': {
			canonicalJsonSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['sessionId', 'text', 'attachments'],
				properties: {
					sessionId: { type: 'string', minLength: 1 },
					text: { type: 'string', maxLength: 65536 },
					attachments: { type: 'array', maxItems: 8, items: { type: 'object' } },
				},
			},
		},
		'omp.session.abort': { canonicalJsonSchema: sessionIdSchema },
		'omp.session.set-model': {
			canonicalJsonSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['sessionId', 'model'],
				properties: {
					sessionId: { type: 'string', minLength: 1 },
					model: { type: 'string', minLength: 1 },
				},
			},
		},
		'omp.session.set-mode': {
			canonicalJsonSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['sessionId', 'mode'],
				properties: {
					sessionId: { type: 'string', minLength: 1 },
					mode: { enum: ['build', 'plan', 'ask'] },
				},
			},
		},
		'omp.approval.resolve': {
			canonicalJsonSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['sessionId', 'requestId', 'approved'],
				properties: {
					sessionId: { type: 'string', minLength: 1 },
					requestId: { type: 'string', minLength: 1 },
					approved: { type: 'boolean' },
				},
			},
		},
		'omp.workspace.retry': { canonicalJsonSchema: emptyObjectSchema },
	},
	eventSchemas: { 'omp.workspace.snapshot': { canonicalJsonSchema: snapshotSchema } },
	resultSchemas: {
		'omp.workspace.snapshot': { canonicalJsonSchema: snapshotSchema },
		'omp.session.select': { canonicalJsonSchema: emptyObjectSchema },
		'omp.session.create': { canonicalJsonSchema: emptyObjectSchema },
		'omp.message.send': { canonicalJsonSchema: emptyObjectSchema },
		'omp.session.abort': { canonicalJsonSchema: emptyObjectSchema },
		'omp.session.set-model': { canonicalJsonSchema: emptyObjectSchema },
		'omp.session.set-mode': { canonicalJsonSchema: emptyObjectSchema },
		'omp.approval.resolve': { canonicalJsonSchema: emptyObjectSchema },
		'omp.workspace.retry': { canonicalJsonSchema: emptyObjectSchema },
	},
	errorSchemas: {
		'omp.panel.error': {
			canonicalJsonSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['code', 'message'],
				properties: {
					code: { type: 'string', minLength: 1 },
					message: { type: 'string', minLength: 1 },
				},
			},
		},
	},
};

export const OMP_PANEL_BRIDGE_DESCRIPTOR_JSON = JSON.stringify(OMP_PANEL_BRIDGE_DESCRIPTOR);

export type OmpBridgeValidation =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: 'unknown_kind' | 'invalid_envelope' };

export function validateOmpBridgeEnvelope(value: unknown): OmpBridgeValidation {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		!('kind' in value) ||
		!('payload' in value)
	)
		return { ok: false, code: 'invalid_envelope' };
	const envelope = value as { kind: unknown; payload: unknown };
	if (
		typeof envelope.kind !== 'string' ||
		!Object.prototype.hasOwnProperty.call(OMP_PANEL_BRIDGE_DESCRIPTOR.requestSchemas, envelope.kind)
	)
		return { ok: false, code: 'unknown_kind' };
	if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload))
		return { ok: false, code: 'invalid_envelope' };
	const schema =
		OMP_PANEL_BRIDGE_DESCRIPTOR.requestSchemas[envelope.kind as OmpPanelRequestKind]
			.canonicalJsonSchema;
	const properties = schema.properties as Record<string, unknown> | undefined;
	const required = schema.required as readonly string[] | undefined;
	if (!properties || !required)
		return Object.keys(envelope.payload).length === 0
			? { ok: true }
			: { ok: false, code: 'invalid_envelope' };
	if (
		Object.keys(envelope.payload).some(
			(key) => !Object.prototype.hasOwnProperty.call(properties, key)
		) ||
		required.some((key) => !(key in (envelope.payload as Record<string, unknown>)))
	)
		return { ok: false, code: 'invalid_envelope' };
	return { ok: true };
}
