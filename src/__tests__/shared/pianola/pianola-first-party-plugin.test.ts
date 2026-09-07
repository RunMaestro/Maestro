import { describe, it, expect } from 'vitest';
import { parsePermissions } from '../../../shared/plugins/permissions';
import { SETTINGS_METADATA } from '../../../shared/settingsMetadata';
import {
	FIRST_PARTY_PLUGIN_DEFINITIONS,
	FIRST_PARTY_PLUGINS,
	GROUPS_PLUS_FIRST_PARTY_PLUGIN,
	GROUPS_PLUS_FIRST_PARTY_PLUGIN_ID,
	GROUPS_PLUS_FIRST_PARTY_PLUGIN_PERMISSIONS,
	PIANOLA_FIRST_PARTY_PLUGIN,
	PIANOLA_FIRST_PARTY_PLUGIN_ID,
	PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS,
} from '../../../shared/plugins/first-party';

describe('Pianola first-party plugin definition', () => {
	it('declares Pianola as a first-party plugin-backed agents extension', () => {
		expect(PIANOLA_FIRST_PARTY_PLUGIN_ID).toBe('com.maestro.pianola');
		expect(PIANOLA_FIRST_PARTY_PLUGIN).toMatchObject({
			id: PIANOLA_FIRST_PARTY_PLUGIN_ID,
			name: 'Pianola',
			firstParty: true,
			category: 'agents',
			settingsNamespace: 'pianola',
			encoreFlag: 'pianola',
			backgroundServices: [{ id: 'pianola.supervisor', kind: 'supervised' }],
		});
		expect(FIRST_PARTY_PLUGINS.pianola).toBe(PIANOLA_FIRST_PARTY_PLUGIN);
	});

	it('requests only valid broker capabilities used by the supervised Pianola flow', () => {
		const parsed = parsePermissions(PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS);
		expect(parsed.errors).toEqual([]);
		// `agents:dispatch` is deliberately NOT declared: FC2 promoted it to an
		// allowlist scope naming exact targets, which a static manifest cannot
		// name for Pianola's dynamically-discovered sessions. Pianola dispatch
		// stays host-owned until the plugin lift designs a runtime grant seam
		// (see first-party.ts NOTE).
		expect(parsed.requests.map((p) => p.capability)).toEqual([
			'settings:read',
			'agents:read',
			'transcripts:read',
			'decisions:write',
			'notifications:toast',
			'background:service',
		]);
		expect(parsed.requests.every((p) => typeof p.reason === 'string' && p.reason.length > 0)).toBe(
			true
		);
	});
});

/**
 * The usage guide the Extensions details pane renders. It lives on the
 * definition (not inline in the view), so these guard what the pane assumes:
 * a non-empty overview, a walkthrough whose steps say something, and agent
 * commands that name real `maestro pianola` verbs rather than an invented
 * binary.
 */
describe('Pianola usage guide', () => {
	const usage = PIANOLA_FIRST_PARTY_PLUGIN.usage;

	it('ships an overview and an ordered walkthrough', () => {
		expect(usage).toBeDefined();
		expect(usage!.overview.length).toBeGreaterThan(0);
		expect(usage!.overview.every((p) => p.trim().length > 0)).toBe(true);
		expect(usage!.steps?.length ?? 0).toBeGreaterThan(0);
		for (const step of usage!.steps ?? []) {
			expect(step.title.trim()).not.toBe('');
			expect(step.body.trim()).not.toBe('');
		}
	});

	it('says how to reach the manager, since Pianola has no hotkey', () => {
		const access = usage!.access ?? [];
		expect(access.length).toBeGreaterThan(0);
		// No shortcutId anywhere: the pane resolves one to a live binding, and
		// naming an id that DEFAULT_SHORTCUTS does not carry would render nothing.
		expect(access.every((path) => path.shortcutId === undefined)).toBe(true);
		expect(access.some((path) => path.commandPalette || path.menu)).toBe(true);
	});

	it('states the two safety guarantees the policy engine actually enforces', () => {
		const notes = (usage!.notes ?? []).join(' ').toLowerCase();
		// High-risk always escalates, and an unmatched prompt escalates rather
		// than being answered. Both are load-bearing claims - if the engine ever
		// stops honoring them, this copy becomes a lie.
		expect(notes).toContain('high-risk');
		expect(notes).toContain('escalate');
	});

	it('documents agent commands under the maestro pianola namespace', () => {
		const commands = usage!.agentCommands ?? [];
		expect(commands.length).toBeGreaterThan(0);
		for (const entry of commands) {
			expect(entry.command.startsWith('maestro pianola ')).toBe(true);
			expect(entry.label.trim()).not.toBe('');
		}
	});

	it('has no em-dashes or en-dashes in user-facing copy', () => {
		const all = [
			...usage!.overview,
			...(usage!.steps ?? []).flatMap((s) => [s.title, s.body]),
			...(usage!.notes ?? []),
			...(usage!.access ?? []).flatMap((a) => [a.label, a.commandPalette ?? '', a.menu ?? '']),
			...(usage!.agentCommands ?? []).flatMap((c) => [c.label, c.command]),
		].join(' ');
		expect(all).not.toMatch(/[\u2013\u2014]/);
	});
});

describe('Groups+ first-party plugin definition', () => {
	it('declares Groups+ as an opt-in first-party UI extension', () => {
		expect(GROUPS_PLUS_FIRST_PARTY_PLUGIN_ID).toBe('com.maestro.groups-plus');
		expect(GROUPS_PLUS_FIRST_PARTY_PLUGIN).toMatchObject({
			id: GROUPS_PLUS_FIRST_PARTY_PLUGIN_ID,
			name: 'Groups+',
			firstParty: true,
			category: 'ui',
			settingsNamespace: 'groupsPlus',
			encoreFlag: 'groupsPlus',
			backgroundServices: [],
		});
		expect(FIRST_PARTY_PLUGINS.groupsPlus).toBe(GROUPS_PLUS_FIRST_PARTY_PLUGIN);
	});

	it('only requests read access to its enabling setting', () => {
		const parsed = parsePermissions(GROUPS_PLUS_FIRST_PARTY_PLUGIN_PERMISSIONS);
		expect(parsed.errors).toEqual([]);
		expect(parsed.requests.map((permission) => permission.capability)).toEqual(['settings:read']);
	});

	it('defaults its Encore flag to off', () => {
		expect(SETTINGS_METADATA.encoreFeatures.default).toMatchObject({ groupsPlus: false });
	});
});

describe('first-party plugin registry', () => {
	it('registers every Encore feature under its plan-stable plugin id', () => {
		expect(FIRST_PARTY_PLUGIN_DEFINITIONS.map((def) => [def.encoreFlag, def.id])).toEqual([
			['usageStats', 'com.maestro.usage-stats'],
			['symphony', 'com.maestro.symphony'],
			['maestroCue', 'com.maestro.cue'],
			['directorNotes', 'com.maestro.director-notes'],
			['pianola', 'com.maestro.pianola'],
			['coworking', 'com.maestro.coworking'],
			['opencodeServer', 'com.maestro.opencode-server'],
			['concerto', 'com.maestro.concerto'],
			['groupsPlus', 'com.maestro.groups-plus'],
			['aCappella', 'com.maestro.acappella'],
		]);
	});

	it('keys the registry by Encore flag with no id or namespace collisions', () => {
		for (const def of FIRST_PARTY_PLUGIN_DEFINITIONS) {
			expect(FIRST_PARTY_PLUGINS[def.encoreFlag]).toBe(def);
		}
		const ids = FIRST_PARTY_PLUGIN_DEFINITIONS.map((def) => def.id);
		expect(new Set(ids).size).toBe(ids.length);
		const namespaces = FIRST_PARTY_PLUGIN_DEFINITIONS.map((def) => def.settingsNamespace);
		expect(new Set(namespaces).size).toBe(namespaces.length);
	});

	it('every definition declares first-party, valid permissions, and supervised-only services', () => {
		for (const def of FIRST_PARTY_PLUGIN_DEFINITIONS) {
			expect(def.firstParty).toBe(true);
			const parsed = parsePermissions(def.permissions);
			expect(parsed.errors).toEqual([]);
			expect(parsed.requests.length).toBeGreaterThan(0);
			// Every feature at least discloses reading its own Encore flag.
			expect(parsed.requests.map((p) => p.capability)).toContain('settings:read');
			// `agents:dispatch` can NEVER appear in static first-party metadata
			// (FC2 allowlist scopes require exact targets; see the Pianola NOTE).
			expect(parsed.requests.map((p) => p.capability)).not.toContain('agents:dispatch');
			for (const service of def.backgroundServices) {
				expect(service.kind).toBe('supervised');
				expect(service.id.length).toBeGreaterThan(0);
			}
		}
	});
});
