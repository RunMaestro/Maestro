import { describe, expect, it } from 'vitest';
import type { Shortcut } from '../../../renderer/types';
import { migrateShortcutSettings } from '../../../renderer/stores/settingsStoreMigrations';

const defaults: Record<string, Shortcut> = {
	moveToGroup: { id: 'moveToGroup', label: 'Move to Group', keys: ['Alt', 'Meta', 'm'] },
	toggleSidebar: { id: 'toggleSidebar', label: 'Toggle sidebar', keys: ['Alt', 'Meta', 'l'] },
};

describe('migrateShortcutSettings', () => {
	it('combines legacy normalization and default remaps in one idempotent write payload', () => {
		const result = migrateShortcutSettings(
			{
				moveToGroup: { id: 'moveToGroup', label: 'Move to Group', keys: ['Meta', 'Shift', 'm'] },
				toggleSidebar: { id: 'toggleSidebar', label: 'Toggle sidebar', keys: ['Alt', 'Meta', '¬'] },
			},
			defaults
		);

		expect(result).toEqual({
			shortcuts: {
				moveToGroup: { ...defaults.moveToGroup, keys: ['Alt', 'Meta', 'm'] },
				toggleSidebar: { ...defaults.toggleSidebar, keys: ['Alt', 'Meta', 'l'] },
			},
			migratedRaw: {
				moveToGroup: { id: 'moveToGroup', label: 'Move to Group', keys: ['Alt', 'Meta', 'm'] },
				toggleSidebar: { id: 'toggleSidebar', label: 'Toggle sidebar', keys: ['Alt', 'Meta', 'l'] },
			},
			needsMigration: true,
		});
	});

	it('does not schedule another write after its persisted output is read again', () => {
		const migrated = migrateShortcutSettings(
			{ moveToGroup: { id: 'moveToGroup', label: 'Move to Group', keys: ['Meta', 'Shift', 'm'] } },
			defaults
		);

		expect(migrateShortcutSettings(migrated.migratedRaw, defaults).needsMigration).toBe(false);
	});
});
