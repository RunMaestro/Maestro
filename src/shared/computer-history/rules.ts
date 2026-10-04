/**
 * Computer History - capture rules (pure).
 *
 * Decides whether an observed event is dropped before it reaches disk. The
 * helper enforces the same rules (it receives them through `configure`), so
 * this is the second line: a helper build that leaks a blocked app, a private
 * window, or a blocked domain still never gets it stored.
 */

import { ALL_BUILT_IN_BLOCKED_APPS, PRIVATE_WINDOW_MARKERS } from './exclusions';
import { normalizeRuleValue } from './config';
import type {
	AppCaptureMode,
	CaptureRule,
	CaptureRuleAction,
	CaptureRuleMatch,
	ObservedEvent,
} from './types';

export type DropReason =
	| 'built-in-app'
	| 'app-rule'
	| 'not-included'
	| 'blocked-pid'
	| 'private-window'
	| 'domain-rule';

export interface RuleContext {
	rules: readonly CaptureRule[];
	/** Defaults to `exclude` (record everything not ignored). */
	appMode?: AppCaptureMode;
	/** Process ids that are never recorded (Maestro's own processes). */
	blockPids?: readonly number[];
}

/** Values of the app rules carrying `action`, in rule order. */
export function appRuleValues(rules: readonly CaptureRule[], action: CaptureRuleAction): string[] {
	return rules.filter((r) => r.match === 'app' && r.action === action).map((r) => r.value);
}

/**
 * An app rule matches the app id OR the display name, case-insensitively, so
 * `rules add --app Slack` does what it says. The helper applies the same rule
 * to `blockApps`. Rule values are stored lowercase (normalizeRuleValue).
 */
export function appRuleMatches(ruleValue: string, app: { id?: string; name?: string }): boolean {
	const v = ruleValue.toLowerCase();
	return (app.id ?? '').toLowerCase() === v || (app.name ?? '').toLowerCase() === v;
}

/** True when a window title carries a private / incognito marker. */
export function isPrivateWindowTitle(title: string | undefined): boolean {
	if (!title) return false;
	const t = title.toLowerCase();
	return PRIVATE_WINDOW_MARKERS.some((m) => t.includes(m));
}

/** Host of a URL, lowercase, or null when it has none. */
export function urlHost(url: string | undefined): string | null {
	if (!url) return null;
	try {
		const host = new URL(url).hostname.toLowerCase();
		return host || null;
	} catch {
		return null;
	}
}

/** `host` equals `domain` or is a subdomain of it. */
export function hostMatchesDomain(host: string, domain: string): boolean {
	const h = host.toLowerCase().replace(/\.$/, '');
	const d = domain.toLowerCase().replace(/^\*?\./, '');
	return h === d || h.endsWith(`.${d}`);
}

/** Why `event` must be dropped, or null when it may be stored. */
export function dropReason(event: ObservedEvent, ctx: RuleContext): DropReason | null {
	const appId = event.app?.id?.toLowerCase();
	if (appId && ALL_BUILT_IN_BLOCKED_APPS.has(appId)) return 'built-in-app';
	if (event.app && ctx.blockPids?.includes(event.app.pid)) return 'blocked-pid';
	if (
		event.app &&
		ctx.rules.some(
			(r) => r.match === 'app' && r.action === 'ignore' && appRuleMatches(r.value, event.app!)
		)
	) {
		return 'app-rule';
	}
	// Include mode fails closed: an event with no app, or an app off the
	// list, is dropped. An empty list records nothing.
	if (
		ctx.appMode === 'include' &&
		!(
			event.app &&
			ctx.rules.some(
				(r) => r.match === 'app' && r.action === 'record' && appRuleMatches(r.value, event.app!)
			)
		)
	) {
		return 'not-included';
	}
	if (isPrivateWindowTitle(event.window?.title)) return 'private-window';
	const host = urlHost(event.window?.url);
	if (
		host &&
		ctx.rules.some(
			(r) => r.match === 'domain' && r.action === 'ignore' && hostMatchesDomain(host, r.value)
		)
	) {
		return 'domain-rule';
	}
	return null;
}

/** Validate user input for `rules add`. Returns an error sentence or null. */
export function validateRuleInput(match: CaptureRuleMatch, value: string): string | null {
	const v = normalizeRuleValue(match, value);
	if (!v) return `A ${match} rule needs a value`;
	if (match === 'domain' && !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(v)) {
		return `"${value}" is not a domain (expected something like bank.example.com)`;
	}
	if (/\s/.test(v)) return `"${value}" contains whitespace`;
	return null;
}
