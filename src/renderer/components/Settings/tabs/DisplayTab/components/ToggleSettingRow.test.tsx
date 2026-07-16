import '@testing-library/jest-dom';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { THEMES } from '../../../../../constants/themes';
import { ToggleSettingRow } from './ToggleSettingRow';

const theme = THEMES.dracula;

describe('ToggleSettingRow', () => {
	it('preserves the setting identifier and toggles from Enter and Space', () => {
		const onChange = vi.fn();
		const { container } = render(
			<ToggleSettingRow
				theme={theme}
				title="Enable updates"
				description="Check for updates when Maestro starts."
				checked={false}
				onChange={onChange}
				ariaLabel="Enable updates"
				clickableRow
				dataSettingId="general-updates"
			/>
		);

		const row = container.querySelector('[data-setting-id="general-updates"]');
		expect(row).toHaveAttribute('role', 'button');
		expect(row).toHaveAttribute('tabindex', '0');

		fireEvent.keyDown(row!, { key: 'Enter' });
		fireEvent.keyDown(row!, { key: ' ' });

		expect(onChange).toHaveBeenCalledTimes(2);
		expect(onChange).toHaveBeenNthCalledWith(1, true);
		expect(onChange).toHaveBeenNthCalledWith(2, true);
	});

	it('does not toggle a disabled clickable row', () => {
		const onChange = vi.fn();
		const { container } = render(
			<ToggleSettingRow
				theme={theme}
				title="Enable updates"
				checked={false}
				onChange={onChange}
				ariaLabel="Enable updates"
				clickableRow
				disabled
			/>
		);

		fireEvent.keyDown(container.querySelector('[role="button"]')!, { key: 'Enter' });
		expect(onChange).not.toHaveBeenCalled();
	});
});
