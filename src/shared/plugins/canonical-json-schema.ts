import type { JsonValue } from './interactive-panel';

export interface JsonValueLimits {
	readonly maxDepth?: number;
	readonly maxNodes?: number;
	readonly maxBytes?: number;
}

export interface CompiledCanonicalJsonSchema {
	validate(value: unknown, limits?: JsonValueLimits): value is JsonValue;
}

export interface JsonValueMeasurement {
	readonly bytes: number;
	readonly nodes: number;
}

type CanonicalType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

type CompiledSchema = {
	readonly type?: CanonicalType;
	readonly constValue?: JsonValue;
	readonly enumValues?: readonly JsonValue[];
	readonly properties?: Readonly<Record<string, CompiledSchema>>;
	readonly required?: ReadonlySet<string>;
	readonly additionalProperties?: boolean;
	readonly items?: CompiledSchema;
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly minBytes?: number;
	readonly maxBytes?: number;
	readonly pattern?: RegExp;
	readonly minimum?: number;
	readonly maximum?: number;
};

const DEFAULT_LIMITS: Required<JsonValueLimits> = {
	maxDepth: 32,
	maxNodes: 10_000,
	maxBytes: 64 * 1024,
};
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 4_096;
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_PATTERN_LENGTH = 1_024;
const SCHEMA_KEYS: Readonly<Record<string, true>> = {
	type: true,
	const: true,
	enum: true,
	properties: true,
	required: true,
	additionalProperties: true,
	items: true,
	minItems: true,
	maxItems: true,
	minLength: true,
	maxLength: true,
	minBytes: true,
	maxBytes: true,
	pattern: true,
	minimum: true,
	maximum: true,
};
const TYPES: Readonly<Record<CanonicalType, true>> = {
	object: true,
	array: true,
	string: true,
	number: true,
	integer: true,
	boolean: true,
	null: true,
};

function isCanonicalType(value: string): value is CanonicalType {
	return hasOwn(TYPES, value);
}

/** Compiles the host's deliberately narrow, data-only JSON Schema subset.
 * Any unknown keyword, malformed constraint, or oversized schema is rejected. */
export function compileCanonicalJsonSchema(canonical: unknown): CompiledCanonicalJsonSchema | null {
	if (
		!isBoundedJsonValue(canonical, {
			maxDepth: MAX_SCHEMA_DEPTH,
			maxNodes: MAX_SCHEMA_NODES,
			maxBytes: MAX_SCHEMA_BYTES,
		})
	)
		return null;
	const schema = compileSchema(canonical);
	if (!schema) return null;
	return Object.freeze({
		validate(value: unknown, limits: JsonValueLimits = {}): value is JsonValue {
			if (!isBoundedJsonValue(value, limits)) return false;
			return matchesCompiledSchema(value, schema);
		},
	});
}

/** Measures JSON shape and serialised UTF-8 bytes without JSON.stringify allocation. */
export function measureJsonValue(
	value: unknown,
	limits: JsonValueLimits = {}
): JsonValueMeasurement | null {
	const resolved = {
		maxDepth: limits.maxDepth ?? DEFAULT_LIMITS.maxDepth,
		maxNodes: limits.maxNodes ?? DEFAULT_LIMITS.maxNodes,
		maxBytes: limits.maxBytes ?? DEFAULT_LIMITS.maxBytes,
	};
	if (
		!Number.isSafeInteger(resolved.maxDepth) ||
		!Number.isSafeInteger(resolved.maxNodes) ||
		!Number.isSafeInteger(resolved.maxBytes) ||
		resolved.maxDepth < 0 ||
		resolved.maxNodes < 1 ||
		resolved.maxBytes < 1
	)
		return null;

	let nodes = 0;
	let bytes = 0;
	const addBytes = (amount: number): boolean => {
		bytes += amount;
		return bytes <= resolved.maxBytes;
	};
	const visit = (entry: unknown, depth: number): boolean => {
		if (depth > resolved.maxDepth || ++nodes > resolved.maxNodes) return false;
		if (entry === null) return addBytes(4);
		if (typeof entry === 'boolean') return addBytes(entry ? 4 : 5);
		if (typeof entry === 'number') {
			if (!Number.isFinite(entry)) return false;
			return addBytes(numberJsonBytes(entry));
		}
		if (typeof entry === 'string') return addBytes(jsonStringBytes(entry));
		if (Array.isArray(entry)) {
			if (!addBytes(2)) return false;
			for (let index = 0; index < entry.length; index += 1) {
				if (index > 0 && !addBytes(1)) return false;
				if (!visit(entry[index], depth + 1)) return false;
			}
			return true;
		}
		if (!isPlainRecord(entry)) return false;
		const keys = Object.keys(entry);
		if (!addBytes(2)) return false;
		for (let index = 0; index < keys.length; index += 1) {
			const key = keys[index];
			const descriptor = Object.getOwnPropertyDescriptor(entry, key);
			if (!descriptor || !('value' in descriptor)) return false;
			if (index > 0 && !addBytes(1)) return false;
			if (!addBytes(jsonStringBytes(key) + 1)) return false;
			if (!visit(descriptor.value, depth + 1)) return false;
		}
		return true;
	};
	return visit(value, 0) ? Object.freeze({ bytes, nodes }) : null;
}

/** Validates JSON shape and serialised UTF-8 byte bounds. */
export function isBoundedJsonValue(
	value: unknown,
	limits: JsonValueLimits = {}
): value is JsonValue {
	return measureJsonValue(value, limits) !== null;
}

function compileSchema(value: JsonValue): CompiledSchema | null {
	if (!isPlainRecord(value)) return null;
	const keys = Object.keys(value);
	if (keys.some((key) => !hasOwn(SCHEMA_KEYS, key))) return null;
	if (keys.length === 0) return Object.freeze({});

	const typeValue = value.type;
	let type: CanonicalType | undefined;
	if (typeValue !== undefined) {
		if (typeof typeValue !== 'string' || !isCanonicalType(typeValue)) return null;
		type = typeValue;
	}
	const constValue = value.const;
	const enumValues = compileEnum(value.enum);
	if (enumValues === null) return null;
	if (constValue !== undefined && !isBoundedJsonValue(constValue)) return null;
	if (type === undefined && constValue === undefined && enumValues === undefined) return null;

	const objectRules = compileObjectRules(value, type);
	if (!objectRules) return null;
	const arrayRules = compileArrayRules(value, type);
	if (!arrayRules) return null;
	const stringRules = compileStringRules(value, type);
	if (!stringRules) return null;
	const numberRules = compileNumberRules(value, type);
	if (!numberRules) return null;

	return Object.freeze({
		type,
		...(constValue === undefined ? {} : { constValue }),
		...(enumValues === undefined ? {} : { enumValues }),
		...objectRules,
		...arrayRules,
		...stringRules,
		...numberRules,
	});
}

function compileObjectRules(
	value: Record<string, JsonValue>,
	type: CanonicalType | undefined
): Partial<CompiledSchema> | null {
	const hasObjectKeyword =
		value.properties !== undefined ||
		value.required !== undefined ||
		value.additionalProperties !== undefined;
	if (!hasObjectKeyword) return {};
	if (type !== 'object') return null;
	let properties: Record<string, CompiledSchema> | undefined;
	if (value.properties !== undefined) {
		if (!isPlainRecord(value.properties)) return null;
		properties = {};
		for (const key of Object.keys(value.properties)) {
			const property = value.properties[key];
			const compiled = compileSchema(property);
			if (!compiled) return null;
			properties[key] = compiled;
		}
	}
	let required: ReadonlySet<string> | undefined;
	if (value.required !== undefined) {
		if (!Array.isArray(value.required) || value.required.some((key) => typeof key !== 'string'))
			return null;
		const entries = new Set(value.required);
		if (entries.size !== value.required.length) return null;
		if (properties && [...entries].some((key) => !(key in properties))) return null;
		required = entries;
	}
	let additionalProperties: boolean | undefined;
	if (value.additionalProperties !== undefined) {
		if (typeof value.additionalProperties !== 'boolean') return null;
		additionalProperties = value.additionalProperties;
	}
	return {
		...(properties === undefined ? {} : { properties: Object.freeze(properties) }),
		...(required === undefined ? {} : { required }),
		...(additionalProperties === undefined ? {} : { additionalProperties }),
	};
}

function compileArrayRules(
	value: Record<string, JsonValue>,
	type: CanonicalType | undefined
): Partial<CompiledSchema> | null {
	const hasArrayKeyword =
		value.items !== undefined || value.minItems !== undefined || value.maxItems !== undefined;
	if (!hasArrayKeyword) return {};
	if (type !== 'array') return null;
	let items: CompiledSchema | undefined;
	if (value.items !== undefined) {
		const compiled = compileSchema(value.items);
		if (!compiled) return null;
		items = compiled;
	}
	const minItems = nonNegativeInteger(value.minItems);
	const maxItems = nonNegativeInteger(value.maxItems);
	if (
		(value.minItems !== undefined && minItems === null) ||
		(value.maxItems !== undefined && maxItems === null)
	)
		return null;
	if (minItems !== null && maxItems !== null && minItems > maxItems) return null;
	return {
		...(items === undefined ? {} : { items }),
		...(minItems === null ? {} : { minItems }),
		...(maxItems === null ? {} : { maxItems }),
	};
}

function compileStringRules(
	value: Record<string, JsonValue>,
	type: CanonicalType | undefined
): Partial<CompiledSchema> | null {
	const hasStringKeyword =
		value.minLength !== undefined ||
		value.maxLength !== undefined ||
		value.minBytes !== undefined ||
		value.maxBytes !== undefined ||
		value.pattern !== undefined;
	if (!hasStringKeyword) return {};
	if (type !== 'string') return null;
	const minLength = nonNegativeInteger(value.minLength);
	const maxLength = nonNegativeInteger(value.maxLength);
	const minBytes = nonNegativeInteger(value.minBytes);
	const maxBytes = nonNegativeInteger(value.maxBytes);
	if (
		(value.minLength !== undefined && minLength === null) ||
		(value.maxLength !== undefined && maxLength === null) ||
		(value.minBytes !== undefined && minBytes === null) ||
		(value.maxBytes !== undefined && maxBytes === null)
	)
		return null;
	if (
		(minLength !== null && maxLength !== null && minLength > maxLength) ||
		(minBytes !== null && maxBytes !== null && minBytes > maxBytes)
	)
		return null;
	let pattern: RegExp | undefined;
	if (value.pattern !== undefined) {
		if (
			typeof value.pattern !== 'string' ||
			value.pattern.length > MAX_PATTERN_LENGTH ||
			!isSafePattern(value.pattern)
		)
			return null;
		try {
			pattern = new RegExp(value.pattern, 'u');
		} catch {
			return null;
		}
	}
	return {
		...(minLength === null ? {} : { minLength }),
		...(maxLength === null ? {} : { maxLength }),
		...(minBytes === null ? {} : { minBytes }),
		...(maxBytes === null ? {} : { maxBytes }),
		...(pattern === undefined ? {} : { pattern }),
	};
}

function compileNumberRules(
	value: Record<string, JsonValue>,
	type: CanonicalType | undefined
): Partial<CompiledSchema> | null {
	const hasNumberKeyword = value.minimum !== undefined || value.maximum !== undefined;
	if (!hasNumberKeyword) return {};
	if (type !== 'number' && type !== 'integer') return null;
	const minimum = finiteNumber(value.minimum);
	const maximum = finiteNumber(value.maximum);
	if (
		(value.minimum !== undefined && minimum === null) ||
		(value.maximum !== undefined && maximum === null)
	)
		return null;
	if (minimum !== null && maximum !== null && minimum > maximum) return null;
	return {
		...(minimum === null ? {} : { minimum }),
		...(maximum === null ? {} : { maximum }),
	};
}

function compileEnum(value: JsonValue | undefined): readonly JsonValue[] | undefined | null {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0) return null;
	const entries: JsonValue[] = [];
	for (const entry of value) {
		if (!isBoundedJsonValue(entry)) return null;
		entries.push(entry);
	}
	return Object.freeze(entries);
}

function matchesCompiledSchema(value: JsonValue, schema: CompiledSchema): boolean {
	if (schema.type && !matchesType(value, schema.type)) return false;
	if (schema.constValue !== undefined && !jsonEquals(value, schema.constValue)) return false;
	if (schema.enumValues && !schema.enumValues.some((entry) => jsonEquals(value, entry)))
		return false;
	if (schema.type === 'object') {
		if (!isPlainRecord(value)) return false;
		if (schema.required && [...schema.required].some((key) => !hasOwn(value, key))) return false;
		for (const key of Object.keys(value)) {
			const property = schema.properties?.[key];
			if (!property) {
				if (schema.additionalProperties === false) return false;
				continue;
			}
			if (!matchesCompiledSchema(value[key], property)) return false;
		}
	}
	if (schema.type === 'array') {
		if (!Array.isArray(value)) return false;
		if (schema.minItems !== undefined && value.length < schema.minItems) return false;
		if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
		if (schema.items && value.some((entry) => !matchesCompiledSchema(entry, schema.items!)))
			return false;
	}
	if (schema.type === 'string') {
		if (typeof value !== 'string') return false;
		const scalarLength = stringScalarLength(value);
		if (schema.minLength !== undefined && scalarLength < schema.minLength) return false;
		if (schema.maxLength !== undefined && scalarLength > schema.maxLength) return false;
		const utf8Bytes = utf8StringBytes(value);
		if (schema.minBytes !== undefined && utf8Bytes < schema.minBytes) return false;
		if (schema.maxBytes !== undefined && utf8Bytes > schema.maxBytes) return false;
		if (schema.pattern && !schema.pattern.test(value)) return false;
	}
	if (schema.type === 'number' || schema.type === 'integer') {
		if (typeof value !== 'number') return false;
		if (schema.minimum !== undefined && value < schema.minimum) return false;
		if (schema.maximum !== undefined && value > schema.maximum) return false;
	}
	return true;
}

function matchesType(value: JsonValue, type: CanonicalType): boolean {
	if (type === 'object') return isPlainRecord(value);
	if (type === 'array') return Array.isArray(value);
	if (type === 'string') return typeof value === 'string';
	if (type === 'number') return typeof value === 'number';
	if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
	if (type === 'boolean') return typeof value === 'boolean';
	return value === null;
}

function jsonEquals(left: JsonValue, right: JsonValue): boolean {
	if (left === right) return true;
	if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null)
		return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		return left.every((value, index) => jsonEquals(value, right[index]));
	}
	if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every((key) => hasOwn(right, key) && jsonEquals(left[key], right[key]))
	);
}

function isPlainRecord(value: unknown): value is Record<string, JsonValue> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return (
		(prototype === Object.prototype || prototype === null) &&
		Object.getOwnPropertySymbols(value).length === 0
	);
}

function hasOwn(value: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function nonNegativeInteger(value: JsonValue | undefined): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteNumber(value: JsonValue | undefined): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isSafePattern(pattern: string): boolean {
	return (
		!/\\[1-9]/.test(pattern) && !/\(\?/.test(pattern) && !/\([^()]*[+*][^()]*\)[+*{]/.test(pattern)
	);
}

function stringScalarLength(value: string): number {
	let length = 0;
	for (let index = 0; index < value.length; index += 1) {
		if (isSurrogatePair(value, index)) index += 1;
		length += 1;
	}
	return length;
}

function utf8StringBytes(value: string): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (isSurrogatePair(value, index)) {
			bytes += 4;
			index += 1;
			continue;
		}
		bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
	}
	return bytes;
}

function numberJsonBytes(value: number): number {
	return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function jsonStringBytes(value: string): number {
	let bytes = 2;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code === 0x22 || code === 0x5c) {
			bytes += 2;
			continue;
		}
		if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
			bytes += 2;
			continue;
		}
		if (code <= 0x1f || (code >= 0xd800 && code <= 0xdfff && !isSurrogatePair(value, index))) {
			bytes += 6;
			continue;
		}
		if (code >= 0xd800 && code <= 0xdbff) {
			bytes += 4;
			index += 1;
			continue;
		}
		bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
	}
	return bytes;
}

function isSurrogatePair(value: string, index: number): boolean {
	const first = value.charCodeAt(index);
	const second = value.charCodeAt(index + 1);
	return first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff;
}
