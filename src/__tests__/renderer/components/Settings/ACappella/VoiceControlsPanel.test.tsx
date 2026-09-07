/**
 * @file VoiceControlsPanel.test.tsx
 *
 * The panel's defining property for the hotkey rows: **what they show is what is
 * actually bound.**
 *
 * The failure this suite exists to prevent was real and silent. Main registers a
 * voice hotkey from `defaultGlobalHotkeyKeys(id)` whenever the stored shortcuts
 * map has no entry, which is the ordinary state of any profile that existed
 * before these hotkeys did. The panel read only that map, so it told those users
 * "Click to set" and "Registered as (none)" about a combo that was live, working,
 * and holding a system-wide accelerator. A settings row that disagrees with the
 * registry is worse than no row: it invites the user to bind a second combo for a
 * hotkey they already have.
 *
 * The other half of the same rule is that an explicitly CLEARED binding still
 * reads as cleared, which is why the fallback is nullish rather than truthy: an
 * entry with an empty key array is a decision, not an absence.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { VoiceControlsPanel } from '../../../../../renderer/components/Settings/ACappella/VoiceControlsPanel';
import type { Shortcut } from '../../../../../renderer/types';
import { mockTheme } from '../../../../helpers/mockTheme';

const voice = () => window.maestro.voice;

/** The stored `shortcuts` map, swapped per test before render. */
let mockShortcuts: Record<string, Shortcut> = {};
const mockSetShortcuts = vi.fn();

vi.mock('../../../../../renderer/hooks/settings/useSettings', () => ({
	useSettings: () => ({
		shortcuts: mockShortcuts,
		setShortcuts: mockSetShortcuts,
		tabShortcuts: {},
		setTabShortcuts: vi.fn(),
	}),
}));

/** What main reports for a hotkey it has actually bound. */
function registered(id: string, keys: string[], accelerator: string) {
	return { id, keys, accelerator, registered: true };
}

describe('VoiceControlsPanel hotkey rows', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockShortcuts = {};
		vi.mocked(window.maestro.settings.get).mockResolvedValue({});
		vi.mocked(voice().getRoster).mockResolvedValue([]);
		vi.mocked(voice().hotkeyStatus).mockResolvedValue({
			statuses: [
				registered('voiceConductor', ['Meta', 'Alt', 'v'], 'Command+Alt+V'),
				registered('voiceCurrentAgent', ['Meta', 'Alt', 'a'], 'Command+Alt+A'),
			],
			note: 'Tap to toggle the microphone.',
		});
	});

	it('shows the combo main actually registered when the stored map has no entry', async () => {
		render(<VoiceControlsPanel theme={mockTheme} enabled />);

		// Two rows, both bound, and neither of them inviting the user to set a
		// hotkey that is already holding a system-wide accelerator.
		await waitFor(() => {
			expect(screen.queryAllByText('(none)')).toHaveLength(0);
		});
		expect(screen.queryAllByText('Click to set')).toHaveLength(0);
	});

	it('still reads as unset when the user has explicitly cleared the binding', async () => {
		mockShortcuts = {
			voiceConductor: { id: 'voiceConductor', label: 'Talk to Maestro', keys: [] },
		};
		vi.mocked(voice().hotkeyStatus).mockResolvedValue({
			statuses: [
				{
					id: 'voiceConductor',
					keys: [],
					accelerator: null,
					registered: false,
					reason: 'invalid-accelerator' as const,
					message: 'No key is bound.',
				},
				registered('voiceCurrentAgent', ['Meta', 'Alt', 'a'], 'Command+Alt+A'),
			],
			note: 'Tap to toggle the microphone.',
		});

		render(<VoiceControlsPanel theme={mockTheme} enabled />);

		// Exactly one row is empty: the cleared one. An empty array is a decision,
		// so it must not fall through to the shipped default.
		await waitFor(() => {
			expect(screen.getAllByText('Click to set')).toHaveLength(1);
		});
	});

	it('prefers a user rebinding over both the registry and the default', async () => {
		mockShortcuts = {
			voiceConductor: {
				id: 'voiceConductor',
				label: 'Talk to Maestro',
				keys: ['Meta', 'Alt', 'j'],
			},
		};

		render(<VoiceControlsPanel theme={mockTheme} enabled />);

		await waitFor(() => {
			expect(screen.getAllByText(/J$/).length).toBeGreaterThan(0);
		});
	});
});
