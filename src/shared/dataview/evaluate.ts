/**
 * Evaluate one Dataview expression with upstream's own evaluator (DV-2). The vendored `Context`
 * supplies the default function library and the binary operators; this wrapper fixes the settings
 * to `DataviewSettings` and binds `this` the way upstream's engine does (`executeInline`).
 */

import type { DataObject, Literal } from './vendor/data-model/value';
import type { Result } from './vendor/api/result';
import type { Field } from './vendor/expression/field';
import { Context, type LinkHandler } from './vendor/expression/context';
import { DataviewSettings } from './settings';

/**
 * Link handler for evaluation with no index behind it: links resolve to nothing, keep the path
 * they were written with, and do not exist. The index service (phase 04) passes a real one.
 */
export const UNRESOLVED_LINK_HANDLER: LinkHandler = Object.freeze({
	resolve: () => null,
	normalize: (path: string) => path,
	exists: () => false,
});

/**
 * Evaluate `field` against `row` (the variables the expression reads by name) with `thisPage`
 * bound to `this`, as upstream does for the page that holds the query. A missing `thisPage`
 * binds an empty object, again as upstream does. An evaluation error is a `Failure` with
 * Dataview's own message.
 */
export function evaluateField(
	field: Field,
	row: Record<string, Literal> = {},
	thisPage: DataObject = {},
	linkHandler: LinkHandler = UNRESOLVED_LINK_HANDLER
): Result<Literal, string> {
	return new Context(linkHandler, DataviewSettings, { this: thisPage }).evaluate(field, row);
}
