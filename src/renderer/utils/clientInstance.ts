/**
 * Which client this page is, in a form that survives a reload of the same tab.
 *
 * Renderer-owned work (an Auto Run loop, today) dies with the page, while the
 * processes it spawned keep running in main. To hand that work back after a
 * reload, main has to be able to tell "the same tab, reloaded" from "a
 * different client", and only the first may take it over: a different client
 * may still be running the same loop, and two loops spawn duplicate tasks into
 * one working tree (#1470).
 *
 * The id lives in sessionStorage, which survives a reload (and a tab the
 * browser discarded to save memory, then restored) and dies with the tab. It is
 * only carried over when this page load IS a reload or a discard-restore: a
 * duplicated tab inherits its parent's sessionStorage while the parent is still
 * alive and still running its loop, so a plain navigation always mints a fresh
 * id.
 */

import { generateId } from './ids';
import { safeSessionStorage, writeStorageValue } from './safeLocalStorage';

const CLIENT_INSTANCE_KEY = 'maestro:clientInstanceId';

interface ClientInstance {
	id: string;
	/** True when `id` was carried over from the page this one reloaded. */
	reloaded: boolean;
}

let instance: ClientInstance | null = null;

/**
 * True when this page load replaced an earlier page in the same tab: a reload,
 * or a tab the browser discarded in the background and reloaded on refocus.
 * Exported for tests.
 */
export function isReloadedPageLoad(): boolean {
	try {
		const discarded = (document as Document & { wasDiscarded?: boolean }).wasDiscarded;
		if (discarded === true) return true;
		const [navigation] = performance.getEntriesByType?.('navigation') ?? [];
		return (navigation as PerformanceNavigationTiming | undefined)?.type === 'reload';
	} catch {
		return false;
	}
}

function resolveClientInstance(): ClientInstance {
	const storage = safeSessionStorage();
	let previous: string | null = null;
	try {
		previous = storage?.getItem(CLIENT_INSTANCE_KEY) ?? null;
	} catch {
		previous = null;
	}
	if (previous && isReloadedPageLoad()) {
		return { id: previous, reloaded: true };
	}
	const id = generateId();
	writeStorageValue(storage, CLIENT_INSTANCE_KEY, id);
	return { id, reloaded: false };
}

/** This client's reload-stable id. */
export function getClientInstanceId(): string {
	instance ??= resolveClientInstance();
	return instance.id;
}

/**
 * True when this page is a reload of a page that held the same id, so work that
 * page left behind in main is this page's to pick up.
 */
export function isReloadedClientInstance(): boolean {
	instance ??= resolveClientInstance();
	return instance.reloaded;
}

/** Test-only: forget the resolved instance so the next read re-resolves it. */
export function resetClientInstanceForTests(): void {
	instance = null;
}
