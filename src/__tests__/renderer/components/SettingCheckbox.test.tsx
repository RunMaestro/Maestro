import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { LucideIcon } from 'lucide-react';
import { SettingCheckbox } from '../../../renderer/components/SettingCheckbox';
import { THEMES } from '../../../shared/themes';

const theme = THEMES.dracula;

const TestIcon = (({ className }: { className?: string }) => (
	<svg aria-hidden="true" className={className} data-testid="setting-icon" />
)) as LucideIcon;

function renderSettingCheckbox(
	overrides: Partial<React.ComponentProps<typeof SettingCheckbox>> = {}
) {
	const onChange = vi.fn();

	render(
		<SettingCheckbox
			icon={TestIcon}
			sectionLabel="Automation"
			title="Run in background"
			description="Keep processing tasks after closing the panel."
			checked={false}
			onChange={onChange}
			theme={theme}
			{...overrides}
		/>
	);

	return { onChange };
}

describe('SettingCheckbox', () => {
	it('renders section label, icon, title, description, and unchecked switch state', () => {
		renderSettingCheckbox();

		expect(screen.getByTestId('setting-icon')).toBeInTheDocument();
		expect(screen.getByText('Automation')).toBeInTheDocument();
		expect(screen.getByText('Run in background')).toBeInTheDocument();
		expect(screen.getByText('Keep processing tasks after closing the panel.')).toBeInTheDocument();

		const switchButton = screen.getByRole('switch');
		expect(switchButton).toHaveAttribute('aria-checked', 'false');
		expect(switchButton).toHaveStyle({ backgroundColor: theme.colors.bgActivity });
		expect(switchButton.firstElementChild).toHaveClass('translate-x-0.5');
	});

	it('renders checked switch styling', () => {
		renderSettingCheckbox({ checked: true });

		const switchButton = screen.getByRole('switch');
		expect(switchButton).toHaveAttribute('aria-checked', 'true');
		expect(switchButton).toHaveStyle({ backgroundColor: theme.colors.accent });
		expect(switchButton.firstElementChild).toHaveClass('translate-x-5');
	});

	it('omits optional description when one is not provided', () => {
		renderSettingCheckbox({ description: undefined });

		expect(
			screen.queryByText('Keep processing tasks after closing the panel.')
		).not.toBeInTheDocument();
	});

	it('toggles from the clickable container', () => {
		const { onChange } = renderSettingCheckbox();

		fireEvent.click(screen.getByRole('button'));

		expect(onChange).toHaveBeenCalledWith(true);
	});

	it('toggles from Enter and Space keyboard activation', () => {
		const { onChange } = renderSettingCheckbox({ checked: true });
		const container = screen.getByRole('button');

		fireEvent.keyDown(container, { key: 'Enter' });
		fireEvent.keyDown(container, { key: ' ' });
		fireEvent.keyDown(container, { key: 'Escape' });

		expect(onChange).toHaveBeenCalledTimes(2);
		expect(onChange).toHaveBeenNthCalledWith(1, false);
		expect(onChange).toHaveBeenNthCalledWith(2, false);
	});

	it('toggles once from the switch without bubbling to the container', () => {
		const { onChange } = renderSettingCheckbox();

		fireEvent.click(screen.getByRole('switch'));

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(true);
	});
});
