/**
 * @file board-first-party.test.ts
 * @description The Board ships as a first-party PROJECTION over host code, so
 * its declared permissions are documentation with teeth: they must match what
 * `src/main/board/*` actually does, and must NOT claim the dispatch authority
 * the host deliberately keeps to itself.
 */

import { describe, it, expect } from 'vitest';
import { BOARD_FIRST_PARTY_PLUGIN } from '../../../shared/plugins/first-party';

const capabilities = BOARD_FIRST_PARTY_PLUGIN.permissions.map((p) => p.capability);

describe('BOARD_FIRST_PARTY_PLUGIN projection', () => {
	it('advertises Board access without a separate Profiles surface', () => {
		expect(BOARD_FIRST_PARTY_PLUGIN.usage?.access).toEqual([
			expect.objectContaining({ shortcutId: 'openBoard' }),
		]);
		expect(JSON.stringify(BOARD_FIRST_PARTY_PLUGIN.usage)).not.toContain('Profiles');
	});

	it('declares every capability the Board actually exercises', () => {
		expect(capabilities).toEqual(
			expect.arrayContaining([
				'settings:read', // dual Encore gate re-read each tick
				'sessions:read', // assignee profile -> base agent resolution
				'notifications:toast', // Phase 2 terminal-transition toasts
				'fs:read',
				'fs:write',
			])
		);
	});

	it('never claims dispatch or spawn (host-owned until the runtime grant seam exists)', () => {
		expect(capabilities).not.toContain('agents:dispatch');
		expect(capabilities).not.toContain('process:spawn');
	});

	it('discloses the active project Profiles write without claiming Board YAML writes', () => {
		const write = BOARD_FIRST_PARTY_PLUGIN.permissions.find((p) => p.capability === 'fs:write');
		// Profiles use a temporary file beside profiles.yaml before rename.
		expect(write?.scope).toBe('.maestro/');
		expect(write?.reason).toContain('profiles.yaml');
		expect(write?.reason).not.toContain('board.yaml');
	});

	it('discloses both legacy migration inputs', () => {
		const readScopes = BOARD_FIRST_PARTY_PLUGIN.permissions
			.filter((p) => p.capability === 'fs:read')
			.map((p) => p.scope);
		expect(readScopes).toEqual(
			expect.arrayContaining(['.maestro/board.yaml', '.maestro/profiles.yaml'])
		);
	});

	it('runs no background service of its own (it rides the Cue tick)', () => {
		expect(BOARD_FIRST_PARTY_PLUGIN.backgroundServices).toEqual([]);
		expect(BOARD_FIRST_PARTY_PLUGIN.encoreFlag).toBe('board');
	});

	it('gives every permission a non-empty reason', () => {
		for (const permission of BOARD_FIRST_PARTY_PLUGIN.permissions) {
			expect(permission.reason.length).toBeGreaterThan(0);
		}
	});
});
