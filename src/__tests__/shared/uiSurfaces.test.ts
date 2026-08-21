/**
 * @file uiSurfaces.test.ts
 * @description Tests for the openable-surface registry behind
 * `maestro-cli open <surface> [--tab]`: name/alias resolution, tab resolution,
 * the discovery hint sentence, and the registry invariants that keep the CLI,
 * the main-process validator, and the renderer dispatcher agreeing.
 */

import { describe, it, expect } from 'vitest';
import {
	UI_SURFACES,
	describeSurfaceAccess,
	resolveUiSurface,
	resolveUiSurfaceTab,
	surfaceTabIds,
} from '../../shared/uiSurfaces';
import { formatShortcutKeysFor } from '../../shared/shortcutKeys';
import { DEFAULT_SHORTCUTS, FIXED_SHORTCUTS } from '../../renderer/constants/shortcuts';

describe('UI surface registry', () => {
	it('has unique ids and aliases across every surface', () => {
		const names = UI_SURFACES.flatMap((surface) => [surface.id, ...(surface.aliases ?? [])]);
		expect(new Set(names).size).toBe(names.length);
	});

	it('references only shortcut ids that actually exist', () => {
		for (const surface of UI_SURFACES) {
			if (!surface.shortcutId) continue;
			const shortcut = DEFAULT_SHORTCUTS[surface.shortcutId] ?? FIXED_SHORTCUTS[surface.shortcutId];
			expect(shortcut, `missing shortcut for ${surface.id}`).toBeDefined();
		}
	});

	it('gives every surface a unique set of tab ids', () => {
		for (const surface of UI_SURFACES) {
			const ids = surfaceTabIds(surface);
			expect(new Set(ids).size).toBe(ids.length);
		}
	});
});

describe('resolveUiSurface', () => {
	it('resolves by id, by alias, and case-insensitively', () => {
		expect(resolveUiSurface('cue')?.id).toBe('cue');
		expect(resolveUiSurface('maestro-cue')?.id).toBe('cue');
		expect(resolveUiSurface('  Usage  ')?.id).toBe('usage-dashboard');
	});

	it('returns null for an unknown or empty name', () => {
		expect(resolveUiSurface('nope')).toBeNull();
		expect(resolveUiSurface('')).toBeNull();
	});
});

describe('resolveUiSurfaceTab', () => {
	const cue = resolveUiSurface('cue')!;

	it('resolves a tab by id and by its display label', () => {
		expect(resolveUiSurfaceTab(cue, 'scheduled')?.id).toBe('scheduled');
		expect(resolveUiSurfaceTab(cue, 'Scheduled Tasks')?.id).toBe('scheduled');
	});

	it('returns null for a tab the surface does not have', () => {
		expect(resolveUiSurfaceTab(cue, 'nope')).toBeNull();
		const about = resolveUiSurface('about')!;
		expect(resolveUiSurfaceTab(about, 'anything')).toBeNull();
	});
});

describe('describeSurfaceAccess', () => {
	it('lists every manual path so an agent can teach the user', () => {
		const cue = resolveUiSurface('cue')!;
		const keys = DEFAULT_SHORTCUTS[cue.shortcutId!].keys;
		const hint = describeSurfaceAccess(cue, formatShortcutKeysFor(keys, false, '+'));
		expect(hint).toContain('Alt+Q');
		expect(hint).toContain('command palette');
		expect(hint).toContain(cue.click!);
	});

	it('omits the hotkey clause when the surface has none', () => {
		const marketplace = resolveUiSurface('marketplace')!;
		const hint = describeSurfaceAccess(marketplace);
		expect(hint).not.toContain('press');
		expect(hint).toContain('command palette');
	});
});

describe('formatShortcutKeysFor', () => {
	it('uses macOS symbols with spaces and text with plus signs elsewhere', () => {
		expect(formatShortcutKeysFor(['Meta', 'Shift', 'k'], true)).toBe('⌘ ⇧ K');
		expect(formatShortcutKeysFor(['Meta', 'Shift', 'k'], false)).toBe('Ctrl+Shift+K');
	});
});
