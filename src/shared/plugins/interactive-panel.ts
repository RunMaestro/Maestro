/**
 * Closed, declarative schema contract for a declared interactive panel.
 *
 * This module deliberately contains no IPC, Electron, global bridge, or runtime
 * acquisition surface. The host later binds a descriptor to a host-issued panel
 * capability; plugins never select an owner, panel instance, or transport route.
 */

export type UUID = string & { readonly __uuid: never };
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

/** A named schema is represented as canonical JSON data, never executable code. */
export interface JsonSchema {
	readonly canonicalJsonSchema: JsonValue;
}

export type JsonSchemaMap = Readonly<Record<string, JsonSchema>>;

export type PanelErrorCode =
	| 'backpressure'
	| 'invalid_request'
	| 'capability_unavailable'
	| 'policy_denied'
	| 'runtime_stopped'
	| 'timeout'
	| 'cancelled';

/**
 * Every mounted panel is bound to one exact descriptor. There is no generic
 * post/send escape hatch in this declaration.
 */
export interface ClosedPanelBridge<
	Requests extends JsonSchemaMap = JsonSchemaMap,
	Events extends JsonSchemaMap = JsonSchemaMap,
	Results extends JsonSchemaMap = JsonSchemaMap,
	Errors extends JsonSchemaMap = JsonSchemaMap,
> {
	readonly requestSchemas: Requests;
	readonly eventSchemas: Events;
	readonly resultSchemas: Results;
	readonly errorSchemas: Errors;
}

export interface PanelRequest<K extends string, P extends JsonValue> {
	readonly kind: K;
	readonly requestId: UUID;
	readonly payload: P;
}

export interface PanelEvent<K extends string, P extends JsonValue> {
	readonly kind: K;
	readonly payload: P;
	readonly eventSequence: bigint;
}

export interface PanelResult<K extends string, P extends JsonValue> {
	readonly kind: K;
	readonly requestId: UUID;
	readonly payload: P;
}

export interface PanelError<K extends string> {
	readonly kind: K;
	readonly requestId: UUID;
	readonly code: PanelErrorCode;
}

/** Opaque panel-owned staged resource metadata, safe inside closed JSON envelopes. */
export interface PanelResourceRef {
	readonly ref: string;
	readonly name: string;
	readonly mediaType: string;
	readonly size: number;
	readonly sha256: string;
}

/** One-shot owner result; byte content never travels in a panel request envelope. */
export interface PanelConsumedResource extends PanelResourceRef {
	readonly bytes: Uint8Array;
}

/**
 * Owner endpoint injected only for the plugin's mounted declared panel. The
 * host derives owner, contribution, descriptor, and instance from this endpoint;
 * no operation accepts a panel or plugin ID.
 */
export interface MaestroInteractivePanelOwnerApi {
	onRequest(listener: (request: PanelRequest<string, JsonValue>) => void): () => void;
	resolve(requestId: UUID, kind: string, payload: JsonValue): Promise<void>;
	reject(requestId: UUID, code: PanelErrorCode): Promise<void>;
	emit(kind: string, payload: JsonValue, eventSequence: bigint): Promise<void>;
	consumeResource(ref: string): Promise<PanelConsumedResource>;
}
