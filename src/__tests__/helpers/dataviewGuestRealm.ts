/**
 * The realm DataviewJS guest scripts run in under vitest. Inline scripts run in jsdom's own realm, not the
 * test's `globalThis`, exactly as the guest runs them in its page (DEV-6), so a test that reads what a
 * script left on its global (or passes the guest its `scriptGlobal`) needs that realm's global object.
 */

import { compileInlineScript } from '../../renderer/dataview-sandbox/inlineScript';

export type DataviewGuestRealm = Record<string, unknown>;

/** The global object inline scripts run against (jsdom's own window under vitest). */
export function dataviewGuestRealm(): DataviewGuestRealm {
	return compileInlineScript(document, {
		params: [],
		body: 'return globalThis;',
		strict: true,
	})() as DataviewGuestRealm;
}
