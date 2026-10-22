/**
 * The value codec for Dataview results on the wire (D2). Dates, durations, and links use upstream's
 * own `Transferable` format (`___transfer-type` objects), so a result survives IPC, the WS bridge,
 * and `JSON.stringify` alike. `Transferable` was written for structured clone and has no case for
 * widgets or non-finite numbers, so those get a `___maestro-wire` tag of their own:
 *
 * - `Widgets.listPair` (a `LIST` with a format) and `Widgets.externalLink` (`elink()`) keep their parts.
 * - Any other widget becomes its `markdown()` text. A function value becomes `<function>`, as upstream
 *   renders it. An HTML element cannot cross a process boundary and becomes null (DQL never makes one).
 * - `NaN` and the infinities, which JSON would turn into null, keep their value.
 */

import { Transferable } from './vendor/data-model/transferable';
import { Values, Widgets, type Literal } from './vendor/data-model/value';
import type {
	DataviewInlineResult,
	DataviewResult,
	DataviewTaskGroups,
	DataviewWireValue,
	RevivedDataviewInlineResult,
	RevivedDataviewResult,
} from './types';

/** The tag key of the values `Transferable` cannot carry. */
const WIRE_TAG = '___maestro-wire';
/** Upstream's tag key (`data-model/transferable.ts`). */
const TRANSFER_TAG = '___transfer-type';

type WireObject = { [key: string]: DataviewWireValue };

/** Encode one Dataview value as plain JSON. */
export function toWireValue(value: Literal | undefined): DataviewWireValue {
	const wrapped = Values.wrapValue(value as Literal);
	if (!wrapped) return null;
	switch (wrapped.type) {
		case 'null':
			return null;
		case 'string':
		case 'boolean':
			return wrapped.value;
		case 'number':
			return Number.isFinite(wrapped.value)
				? wrapped.value
				: { [WIRE_TAG]: 'number', value: String(wrapped.value) };
		case 'date':
		case 'duration':
		case 'link':
			return Transferable.transferable(wrapped.value) as DataviewWireValue;
		case 'array':
			return Array.from(wrapped.value, (item) => toWireValue(item));
		case 'object': {
			const result: WireObject = {};
			for (const [key, item] of Object.entries(wrapped.value)) {
				if (item !== undefined) result[key] = toWireValue(item);
			}
			return result;
		}
		case 'widget': {
			const widget = wrapped.value;
			if (Widgets.isListPair(widget)) {
				return {
					[WIRE_TAG]: 'list-pair',
					key: toWireValue(widget.key),
					value: toWireValue(widget.value),
				};
			}
			if (Widgets.isExternalLink(widget)) {
				const encoded: WireObject = { [WIRE_TAG]: 'external-link', url: widget.url };
				if (widget.display !== undefined) encoded.display = widget.display;
				return encoded;
			}
			return widget.markdown();
		}
		case 'function':
			return '<function>';
		case 'html':
			return null;
	}
}

/** Decode what {@link toWireValue} produced back into a Dataview value. */
export function fromWireValue(value: DataviewWireValue): Literal {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map(fromWireValue);
	if (TRANSFER_TAG in value) return Transferable.value(value) as Literal;
	if (WIRE_TAG in value) {
		switch (value[WIRE_TAG]) {
			case 'number':
				return Number(value.value);
			case 'list-pair':
				return Widgets.listPair(fromWireValue(value.key), fromWireValue(value.value));
			case 'external-link':
				return Widgets.externalLink(
					String(value.url),
					typeof value.display === 'string' ? value.display : undefined
				);
		}
	}
	const result: Record<string, Literal> = {};
	for (const [key, item] of Object.entries(value)) result[key] = fromWireValue(item);
	return result;
}

/** Map every value of a task grouping, keeping its shape. */
export function mapTaskGroups<A, B>(
	groups: DataviewTaskGroups<A>,
	map: (value: A) => B
): DataviewTaskGroups<B> {
	return (groups as unknown[]).map((entry) =>
		isTaskGroup<A>(entry)
			? { key: map(entry.key), rows: mapTaskGroups(entry.rows, map) }
			: map(entry as A)
	) as DataviewTaskGroups<B>;
}

/** Whether one entry of a task grouping is a `GROUP BY` level (`{ key, rows }`) rather than a task. */
export function isTaskGroup<V>(entry: unknown): entry is { key: V; rows: DataviewTaskGroups<V> } {
	return (
		entry !== null &&
		typeof entry === 'object' &&
		!Array.isArray(entry) &&
		'rows' in entry &&
		'key' in entry &&
		Array.isArray((entry as { rows: unknown }).rows) &&
		!('task' in entry)
	);
}

/** Restore the Dataview values in a result received over IPC, the bridge, or JSON. */
export function reviveDataviewResult(result: DataviewResult): RevivedDataviewResult {
	switch (result.kind) {
		case 'table':
			return { ...result, rows: result.rows.map((row) => row.map(fromWireValue)) };
		case 'list':
			return { ...result, items: result.items.map(fromWireValue) };
		case 'task':
			return { ...result, groups: mapTaskGroups(result.groups, fromWireValue) };
		case 'unsupported':
		case 'error':
			return result;
	}
}

/** Restore the value of an inline result received over IPC, the bridge, or JSON. */
export function reviveDataviewInlineResult(
	result: DataviewInlineResult
): RevivedDataviewInlineResult {
	return result.kind === 'value' ? { kind: 'value', value: fromWireValue(result.value) } : result;
}
