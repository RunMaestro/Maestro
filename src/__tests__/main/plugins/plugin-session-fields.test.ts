/**
 * @file plugin-session-fields.test.ts
 * @description Unit tests for the pure host-side field handling extracted from
 * `src/main/index.ts`'s `pluginSessionsCreate` / `pluginSessionsUpdate` /
 * `listAgents` closures: the `additionalDirectories` fail-closed scope rule,
 * the `customModel` / `customEffort` overrides, the user-owned field refusal,
 * the `~` cwd expansion and userData exclusion, and the `agents.list` capability
 * flag.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
	resolvePluginSessionCreateFields,
	resolvePluginSessionUpdateFields,
	mapPluginAgentEntries,
	USER_OWNED_SESSION_FIELDS,
	type PluginSessionFieldsDeps,
} from '../../../main/plugins/plugin-session-fields';

// `~` expansion reads os.homedir() (via shared/pathUtils' expandTilde). Stub it
// to a throwaway temp directory so nothing in this file can read or write the
// real home folder. Minted lazily and remembered, matching the pattern in
// plugin-host-handlers.test.ts so both files agree on what "home" means.
const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	const fsActual = await vi.importActual<typeof import('fs')>('fs');
	const pathActual = await vi.importActual<typeof import('path')>('path');
	return {
		...actual,
		homedir: () => {
			if (!home.dir) {
				home.dir = fsActual.realpathSync(
					fsActual.mkdtempSync(pathActual.join(actual.tmpdir(), 'maestro-psf-home-'))
				);
			}
			return home.dir;
		},
	};
});

let tmpDirs: string[] = [];
beforeEach(() => {
	tmpDirs = [];
});
afterEach(() => {
	for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A raw session record shaped the way `pluginSessionsRaw()` reads it off the
 * store: enough fields for `resolveSessionProjectRoot` to resolve a root. */
function rawSession(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		id: 's1',
		toolType: 'claude-code',
		projectRoot: '/granted/root',
		cwd: '/granted/root',
		...over,
	};
}

function makeDeps(over: Partial<PluginSessionFieldsDeps> = {}): PluginSessionFieldsDeps {
	return {
		protectedPaths: () => ['/userdata'],
		rawSessions: () => [],
		isSessionGranted: () => false,
		usesSessionGrants: () => true,
		...over,
	};
}

describe('resolvePluginSessionUpdateFields: additionalDirectories scope rule', () => {
	it('accepts a directory equal to the resolved project root of a session granted to the plugin', () => {
		const deps = makeDeps({
			rawSessions: () => [rawSession({ id: 's1' })],
			isSessionGranted: (pluginId, sessionId) => pluginId === 'p' && sessionId === 's1',
		});
		const result = resolvePluginSessionUpdateFields(
			{ additionalDirectories: [{ path: '/granted/root', read: true }] },
			'p',
			deps
		);
		expect(result.set.additionalDirectories).toEqual([
			{ path: '/granted/root', read: true, write: false },
		]);
		expect(result.clear).toEqual([]);
	});

	it('rejects the project root of a session that exists but is not granted to this plugin', () => {
		const deps = makeDeps({
			rawSessions: () => [
				rawSession({ id: 'granted-session', projectRoot: '/granted/root', cwd: '/granted/root' }),
				rawSession({ id: 'other-session', projectRoot: '/ungranted/root', cwd: '/ungranted/root' }),
			],
			isSessionGranted: (pluginId, sessionId) =>
				pluginId === 'p' && sessionId === 'granted-session',
		});
		expect(() =>
			resolvePluginSessionUpdateFields(
				{ additionalDirectories: [{ path: '/ungranted/root', read: true }] },
				'p',
				deps
			)
		).toThrow(/is not the project root of a session granted to this plugin/);
	});

	it('rejects an arbitrary path that names no session at all, with the specific error', () => {
		const deps = makeDeps({
			rawSessions: () => [rawSession({ id: 's1' })],
			isSessionGranted: (pluginId, sessionId) => pluginId === 'p' && sessionId === 's1',
		});
		expect(() =>
			resolvePluginSessionUpdateFields(
				{ additionalDirectories: [{ path: '/etc/passwd-adjacent', read: true }] },
				'p',
				deps
			)
		).toThrow(
			/"\/etc\/passwd-adjacent" is not the project root of a session granted to this plugin/
		);
	});

	it('rejects a relative directory', () => {
		const deps = makeDeps({
			rawSessions: () => [rawSession({ id: 's1' })],
			isSessionGranted: () => true,
		});
		expect(() =>
			resolvePluginSessionUpdateFields(
				{ additionalDirectories: [{ path: 'relative/dir', read: true }] },
				'p',
				deps
			)
		).toThrow(/must be an absolute directory/);
	});

	it('rejects a directory with a traversal segment', () => {
		const deps = makeDeps({
			rawSessions: () => [rawSession({ id: 's1' })],
			isSessionGranted: () => true,
		});
		expect(() =>
			resolvePluginSessionUpdateFields(
				{ additionalDirectories: [{ path: '/granted/root/../escape', read: true }] },
				'p',
				deps
			)
		).toThrow(/must not contain a "\.\." segment/);
	});

	it('rejects a home-relative (~) directory rather than silently expanding it', () => {
		const deps = makeDeps({
			rawSessions: () => [rawSession({ id: 's1' })],
			isSessionGranted: () => true,
		});
		expect(() =>
			resolvePluginSessionUpdateFields(
				{ additionalDirectories: [{ path: '~/granted/root', read: true }] },
				'p',
				deps
			)
		).toThrow(/must be an absolute directory, not a home-relative path/);
	});

	it('rejects write:true for a plugin that uses session grants, even on an otherwise-valid root', () => {
		const deps = makeDeps({
			rawSessions: () => [rawSession({ id: 's1' })],
			isSessionGranted: () => true,
			usesSessionGrants: () => true,
		});
		expect(() =>
			resolvePluginSessionUpdateFields(
				{ additionalDirectories: [{ path: '/granted/root', write: true }] },
				'p',
				deps
			)
		).toThrow(/cannot be granted write access by a plugin/);
	});

	it('does not reject write:true for a plugin that does not use session grants', () => {
		const deps = makeDeps({
			rawSessions: () => [rawSession({ id: 's1' })],
			isSessionGranted: () => true,
			usesSessionGrants: () => false,
		});
		const result = resolvePluginSessionUpdateFields(
			{ additionalDirectories: [{ path: '/granted/root', write: true }] },
			'p',
			deps
		);
		expect(result.set.additionalDirectories).toEqual([
			{ path: '/granted/root', read: false, write: true },
		]);
	});

	it('normalizes duplicate entries (last write wins) before the scope check runs', () => {
		const deps = makeDeps({
			rawSessions: () => [rawSession({ id: 's1' })],
			isSessionGranted: () => true,
		});
		const result = resolvePluginSessionUpdateFields(
			{
				additionalDirectories: [
					{ path: '/granted/root', read: false },
					{ path: '/granted/root', read: true },
				],
			},
			'p',
			deps
		);
		expect(result.set.additionalDirectories).toEqual([
			{ path: '/granted/root', read: true, write: false },
		]);
	});

	it('clears additionalDirectories (deletion, not a persisted empty array) when the list is empty', () => {
		const deps = makeDeps({ rawSessions: () => [rawSession({ id: 's1' })] });
		const result = resolvePluginSessionUpdateFields({ additionalDirectories: [] }, 'p', deps);
		expect(result.clear).toContain('additionalDirectories');
		expect(result.set.additionalDirectories).toBeUndefined();
	});

	it('fails closed for a plugin with no granted sessions at all: no directory is acceptable', () => {
		const deps = makeDeps({ rawSessions: () => [], isSessionGranted: () => false });
		expect(() =>
			resolvePluginSessionUpdateFields(
				{ additionalDirectories: [{ path: '/anything', read: true }] },
				'p',
				deps
			)
		).toThrow(/this plugin has no granted sessions/);
	});
});

describe('a created session is granted to its creating plugin: the grant immediately widens reach', () => {
	it('accepts the new session root once isSessionGranted reports the post-create grant', () => {
		// Mirrors index.ts's pluginSessionsCreate: the session is appended to the
		// store, then (because usesSessionGrants is true) grantSession() runs
		// before any later update. We simulate that ordering by having
		// isSessionGranted answer true for the session id the plugin just made.
		const deps = makeDeps({
			rawSessions: () => [
				rawSession({ id: 'new-session', projectRoot: '/new/project', cwd: '/new/project' }),
			],
			isSessionGranted: (pluginId, sessionId) => pluginId === 'p' && sessionId === 'new-session',
		});
		const result = resolvePluginSessionUpdateFields(
			{ additionalDirectories: [{ path: '/new/project', read: true }] },
			'p',
			deps
		);
		expect(result.set.additionalDirectories).toEqual([
			{ path: '/new/project', read: true, write: false },
		]);
	});

	it('rejects that same root before the grant lands (not yet in the grant set)', () => {
		const deps = makeDeps({
			rawSessions: () => [
				rawSession({ id: 'new-session', projectRoot: '/new/project', cwd: '/new/project' }),
			],
			isSessionGranted: () => false,
		});
		expect(() =>
			resolvePluginSessionUpdateFields(
				{ additionalDirectories: [{ path: '/new/project', read: true }] },
				'p',
				deps
			)
		).toThrow(/is not the project root of a session granted to this plugin/);
	});
});

describe('customModel / customEffort', () => {
	it('are stored on create', () => {
		const deps = makeDeps();
		const result = resolvePluginSessionCreateFields(
			{ customModel: 'opus', customEffort: 'high' },
			'p',
			deps
		);
		expect(result.optional.customModel).toBe('opus');
		expect(result.optional.customEffort).toBe('high');
	});

	it('are stored on update, and an empty string clears rather than sets', () => {
		const deps = makeDeps();
		const set = resolvePluginSessionUpdateFields(
			{ customModel: 'sonnet', customEffort: 'medium' },
			'p',
			deps
		);
		expect(set.set.customModel).toBe('sonnet');
		expect(set.set.customEffort).toBe('medium');

		const cleared = resolvePluginSessionUpdateFields(
			{ customModel: '', customEffort: '  ' },
			'p',
			deps
		);
		expect(cleared.clear).toEqual(expect.arrayContaining(['customModel', 'customEffort']));
		expect(cleared.set.customModel).toBeUndefined();
		expect(cleared.set.customEffort).toBeUndefined();
	});

	it('rejects a non-string value', () => {
		const deps = makeDeps();
		expect(() => resolvePluginSessionCreateFields({ customModel: 42 }, 'p', deps)).toThrow(
			/customModel must be a string/
		);
	});
});

describe('user-owned fields are never applied, however they are spelled in params', () => {
	it.each(USER_OWNED_SESSION_FIELDS)('ignores %s on create', (field) => {
		const deps = makeDeps();
		const result = resolvePluginSessionCreateFields(
			{ [field]: 'anything-a-plugin-could-send' },
			'p',
			deps
		);
		expect(result.optional).not.toHaveProperty(field);
	});

	it.each(USER_OWNED_SESSION_FIELDS)('ignores %s on update (neither set nor cleared)', (field) => {
		const deps = makeDeps();
		const result = resolvePluginSessionUpdateFields(
			{ [field]: 'anything-a-plugin-could-send' },
			'p',
			deps
		);
		expect(result.set).not.toHaveProperty(field);
		expect(result.clear).not.toContain(field);
	});
});

describe('resolvePluginSessionCreateFields: cwd', () => {
	it('expands a leading ~ against the stubbed home directory', () => {
		const deps = makeDeps({ protectedPaths: () => ['/this-userdata-never-matches'] });
		const result = resolvePluginSessionCreateFields({ cwd: '~/scratch/board-1' }, 'p', deps);
		expect(result.cwd).toBe(`${home.dir}/scratch/board-1`);
	});

	it('defaults to the home directory itself when no cwd/projectPath is given', () => {
		const deps = makeDeps({ protectedPaths: () => ['/this-userdata-never-matches'] });
		const result = resolvePluginSessionCreateFields({}, 'p', deps);
		expect(result.cwd).toBe(home.dir);
	});

	it('rejects a cwd inside a protected (userData) path', () => {
		const userData = path.join(home.dir, 'userData');
		const deps = makeDeps({ protectedPaths: () => [userData] });
		expect(() =>
			resolvePluginSessionCreateFields({ cwd: path.join(userData, 'plugins', 'kanban') }, 'p', deps)
		).toThrow(/is inside Maestro's data directory and is not allowed/);
	});

	it('rejects a ~-relative cwd that expands into a protected path', () => {
		const userData = path.join(home.dir, 'userData');
		const deps = makeDeps({ protectedPaths: () => [userData] });
		expect(() =>
			resolvePluginSessionCreateFields({ cwd: '~/userData/plugins/kanban' }, 'p', deps)
		).toThrow(/is inside Maestro's data directory and is not allowed/);
	});

	it('prefers projectPath over cwd when both are supplied', () => {
		const deps = makeDeps();
		const result = resolvePluginSessionCreateFields(
			{ projectPath: '/explicit/project', cwd: '/other/ignored' },
			'p',
			deps
		);
		expect(result.cwd).toBe('/explicit/project');
	});
});

describe('mapPluginAgentEntries: supportsAdditionalDirectories', () => {
	it('carries whatever getAgentCapabilities(toolType) reports, via the injected lookup', () => {
		const sessions = [
			{ id: 'a', name: 'A', toolType: 'claude-code' },
			{ id: 'b', name: 'B', toolType: 'terminal' },
		];
		const getCapabilities = (toolType: string) => ({
			supportsAdditionalDirectories: toolType === 'claude-code',
		});
		const entries = mapPluginAgentEntries(sessions, getCapabilities);
		expect(entries).toEqual([
			{ id: 'a', name: 'A', toolType: 'claude-code', supportsAdditionalDirectories: true },
			{ id: 'b', name: 'B', toolType: 'terminal', supportsAdditionalDirectories: false },
		]);
	});

	it('uses the real agent capability registry by default', () => {
		const entries = mapPluginAgentEntries([
			{ id: 'a', name: 'A', toolType: 'claude-code' },
			{ id: 'b', name: 'B', toolType: 'terminal' },
		]);
		expect(entries.find((e) => e.id === 'a')?.supportsAdditionalDirectories).toBe(true);
		expect(entries.find((e) => e.id === 'b')?.supportsAdditionalDirectories).toBe(false);
	});

	it('filters out entries with no string id', () => {
		const entries = mapPluginAgentEntries([{ id: 'a', name: 'A' }, { name: 'no-id' }]);
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe('a');
	});
});
