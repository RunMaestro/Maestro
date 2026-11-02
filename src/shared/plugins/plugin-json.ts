import { canonicalJson } from '../canonicalJson';
import {
	PLUGIN_PRIMITIVE_ERRORS,
	PLUGIN_TOPIC_PATTERN,
	type PluginPrimitiveErrorCode,
	type PluginJson,
} from './primitives';
import { PLUGIN_ID_PATTERN } from './plugin-manifest';
import type { CuePluginSource } from '../cue/contracts';

export class PluginAuthorityError extends Error {
	constructor(readonly code: PluginPrimitiveErrorCode) {
		super(PLUGIN_PRIMITIVE_ERRORS[code]);
	}
}

/** Closed plain JSON requests; never run a supplied accessor/toJSON. */
export function pluginRequest(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = []
): Record<string, unknown> {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		![null, Object.prototype].includes(Object.getPrototypeOf(value))
	)
		throw new PluginAuthorityError('PLUGIN_INVALID');
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (
		Reflect.ownKeys(descriptors).some(
			(key) => typeof key !== 'string' || ![...required, ...optional].includes(key)
		) ||
		required.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key)) ||
		Object.values(descriptors).some((d) => !('value' in d))
	)
		throw new PluginAuthorityError('PLUGIN_INVALID');
	return Object.fromEntries(Object.entries(descriptors).map(([key, d]) => [key, d.value]));
}

/** Bound before canonicalizing, then detach from mutable plugin/host objects. */
export function pluginJson(value: unknown, maxBytes = 16 * 1024): PluginJson {
	let nodes = 0;
	const visit = (v: unknown, depth: number): void => {
		if (++nodes > 16384 || depth > 16) throw new PluginAuthorityError('PLUGIN_LIMIT');
		if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
			return;
		if (typeof v === 'string') {
			if (v.length > maxBytes) throw new PluginAuthorityError('PLUGIN_LIMIT');
			return;
		}
		if (
			!v ||
			typeof v !== 'object' ||
			(!Array.isArray(v) && ![null, Object.prototype].includes(Object.getPrototypeOf(v)))
		)
			throw new PluginAuthorityError('PLUGIN_INVALID');
		if (Reflect.ownKeys(v).length > 16384) throw new PluginAuthorityError('PLUGIN_LIMIT');
		for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
			if (Array.isArray(v) && key === 'length') continue;
			if (!('value' in d) || key.length > maxBytes)
				throw new PluginAuthorityError('PLUGIN_INVALID');
			visit(d.value, depth + 1);
		}
	};
	visit(value, 0);
	try {
		const text = canonicalJson(value);
		if (new TextEncoder().encode(text).length > maxBytes)
			throw new PluginAuthorityError('PLUGIN_LIMIT');
		return JSON.parse(text) as PluginJson;
	} catch (error) {
		throw error instanceof PluginAuthorityError
			? error
			: new PluginAuthorityError('PLUGIN_INVALID');
	}
}

export function parseCuePluginSource(value: unknown): CuePluginSource {
	const p = pluginRequest(value, ['pluginId', 'topic', 'config']);
	if (
		typeof p.pluginId !== 'string' ||
		p.pluginId.length > 100 ||
		!PLUGIN_ID_PATTERN.test(p.pluginId) ||
		typeof p.topic !== 'string' ||
		!PLUGIN_TOPIC_PATTERN.test(p.topic)
	)
		throw new PluginAuthorityError('PLUGIN_INVALID');
	return { pluginId: p.pluginId, topic: p.topic, config: pluginJson(p.config) };
}
