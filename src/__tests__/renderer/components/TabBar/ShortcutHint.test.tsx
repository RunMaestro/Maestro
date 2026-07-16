import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('../../../../renderer/utils/shortcutFormatter');
import { ShortcutHint } from '../../../../renderer/components/TabBar/ShortcutHint';
import { mockTheme } from '../../../helpers/mockTheme';

const initialPlatform = window.maestro.platform;

afterEach(() => {
	window.maestro.platform = initialPlatform;
});

describe('ShortcutHint', () => {
	it('uses the Windows visual and accessible shortcut labels', () => {
		window.maestro.platform = 'win32';

		render(<ShortcutHint keys={['Meta', 'Shift', 'w']} theme={mockTheme} />);

		expect(screen.getByText('Ctrl+Shift+W')).toBeInTheDocument();
		expect(
			screen.getByRole('note', { name: 'Keyboard shortcut: Ctrl Shift W' })
		).toBeInTheDocument();
	});

	it('uses the macOS visual and accessible shortcut labels', () => {
		window.maestro.platform = 'darwin';

		render(<ShortcutHint keys={['Meta', 'Alt', 'ArrowLeft']} theme={mockTheme} />);

		expect(screen.getByText('⌘ ⌥ ←')).toBeInTheDocument();
		expect(
			screen.getByRole('note', { name: 'Keyboard shortcut: Command Option Arrow Left' })
		).toBeInTheDocument();
	});
});
