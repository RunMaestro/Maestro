/**
 * The sessions and groups stores, answered by the runtime (4.1 of the migration plan).
 *
 * Main code reads the agent tree through `sessionsStore.get('sessions')` in a few dozen places (the web
 * server's callbacks, the debug package, the plugin verbs) and writes it in a handful. While the runtime
 * is hosted it is the only writer of `maestro-sessions.json` and `maestro-groups.json`, so those calls
 * must not reach electron-store: a write there would be a second writer of the file the runtime owns.
 *
 * This replaces `get`, `set`, `has` on the two store instances (the same own-property technique
 * `deferStoreWrites` uses), so every existing reader and writer keeps its call and gains one swap point:
 *
 * - Reads come from the runtime's in-memory documents, as shallow array copies, as the deferred store
 *   handed them out.
 * - `set('sessions', array)` is a fold at the current revision, with `setAll` meaning for a whole array:
 *   an agent it leaves out is removed (a plugin verb deleting one), a new one is adopted, and domain
 *   edits land. The fold is asynchronous and `set` is not, so the written array is served to readers
 *   until the fold settles: `set` followed by `get` sees what was set.
 * - `set('activeSessionId', id)` is a fold of the active id alone.
 *
 * Design: `Plans/maestro-tui-desktop-migration.md` section 4.1.
 */

import type Store from 'electron-store';

import type { DesktopBinding } from './desktop-binding';
import type { DesktopRuntimeApi } from '../../shared/maestro-lib/agents/desktop-fold-types';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[LibraryRuntime]';

export interface StoreFacadeDeps {
	sessionsStore: Store<any>;
	groupsStore: Store<any>;
	desktop: DesktopRuntimeApi;
	binding: Pick<DesktopBinding, 'writeSessions' | 'setActiveSessionId' | 'foldLegacyGroups'>;
}

/** Put the stores back as they were. For tests and for a runtime that closes. */
export type StoreFacadeRemoval = () => void;

function own(target: object, name: string, value: (...args: never[]) => unknown): () => void {
	const had = Object.getOwnPropertyDescriptor(target, name);
	Object.defineProperty(target, name, { value, writable: true, configurable: true });
	return () => {
		if (had) Object.defineProperty(target, name, had);
		else delete (target as Record<string, unknown>)[name];
	};
}

const copyIfArray = (value: unknown): unknown => (Array.isArray(value) ? [...value] : value);

export function installRuntimeStoreFacade(deps: StoreFacadeDeps): StoreFacadeRemoval {
	const { sessionsStore, groupsStore, desktop, binding } = deps;
	const restores: Array<() => void> = [];

	/** What `set('sessions')` last wrote, served until its fold settles. */
	let sessionsOverlay: unknown[] | undefined;
	let activeOverlay: string | undefined;

	const reportFailure = (what: string, error: unknown): void => {
		logger.error(
			`The runtime store facade could not write ${what}: ${error instanceof Error ? error.message : String(error)}`,
			LOG_CONTEXT
		);
	};

	restores.push(
		own(sessionsStore, 'get', (key: string, defaultValue?: unknown) => {
			if (key === 'sessions') {
				const sessions = sessionsOverlay ?? desktop.documents().sessions.sessions;
				return sessions === undefined ? defaultValue : [...sessions];
			}
			if (key === 'activeSessionId') {
				return activeOverlay ?? desktop.documents().sessions.activeSessionId ?? defaultValue;
			}
			const value = (desktop.documents().sessions as Record<string, unknown>)[key];
			return value === undefined ? defaultValue : copyIfArray(value);
		}),
		own(sessionsStore, 'has', (key: string) => key in desktop.documents().sessions),
		own(sessionsStore, 'set', (keyOrObject: string | Record<string, unknown>, value?: unknown) => {
			const entries =
				typeof keyOrObject === 'string'
					? ([[keyOrObject, value]] as Array<[string, unknown]>)
					: Object.entries(keyOrObject);
			for (const [key, next] of entries) {
				if (key === 'sessions' && Array.isArray(next)) {
					const written = next as Record<string, unknown>[];
					sessionsOverlay = written;
					void binding
						.writeSessions(written, { removeAbsent: true })
						.catch((error) => reportFailure('sessions', error))
						.finally(() => {
							if (sessionsOverlay === written) sessionsOverlay = undefined;
						});
				} else if (key === 'activeSessionId' && typeof next === 'string') {
					activeOverlay = next;
					void binding
						.setActiveSessionId(next)
						.catch((error) => reportFailure('activeSessionId', error))
						.finally(() => {
							if (activeOverlay === next) activeOverlay = undefined;
						});
				} else {
					logger.warn(`The runtime store facade ignored a write to '${key}'`, LOG_CONTEXT);
				}
			}
		}),
		own(groupsStore, 'get', (key: string, defaultValue?: unknown) => {
			const value = (desktop.documents().groups as Record<string, unknown>)[key];
			return value === undefined ? defaultValue : copyIfArray(value);
		}),
		own(groupsStore, 'has', (key: string) => key in desktop.documents().groups),
		own(groupsStore, 'set', (keyOrObject: string | Record<string, unknown>, value?: unknown) => {
			const groups =
				typeof keyOrObject === 'string'
					? keyOrObject === 'groups'
						? value
						: undefined
					: keyOrObject.groups;
			if (!Array.isArray(groups)) {
				logger.warn('The runtime store facade ignored a write to the groups store', LOG_CONTEXT);
				return;
			}
			void binding
				.foldLegacyGroups(groups as Array<{ id: string; collapsed?: boolean }>)
				.catch((error) => reportFailure('groups', error));
		})
	);

	return () => {
		for (const restore of restores.reverse()) restore();
	};
}
