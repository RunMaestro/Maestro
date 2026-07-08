import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToggleButtonGroup } from '../../../renderer/components/ToggleButtonGroup';
import type { Theme } from '../../../renderer/types';

const theme: Theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#000000',
		bgSidebar: '#111111',
		bgActivity: '#181818',
		border: '#333333',
		textMain: '#f4f4f4',
		textDim: '#999999',
		accent: '#4f9cff',
		accentDim: '#4f9cff33',
		accentText: '#ffffff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

describe('ToggleButtonGroup', () => {
	it('renders primitive, mapped, and explicit labels and reports selection changes', () => {
		const onChange = vi.fn();

		render(
			<ToggleButtonGroup
				options={[
					'raw',
					'mapped',
					{
						value: 'custom',
						label: 'Explicit label',
						activeColor: '#ff00aa',
						ringColor: '#00ffaa',
						activeTextColor: '#111111',
					},
				]}
				value="custom"
				onChange={onChange}
				theme={theme}
				labels={{ mapped: 'Mapped label' }}
			/>
		);

		expect(screen.getByRole('button', { name: 'raw' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Mapped label' })).toBeInTheDocument();

		const activeButton = screen.getByRole('button', { name: 'Explicit label' });
		expect(activeButton).toHaveStyle({
			backgroundColor: '#ff00aa',
			color: '#111111',
		});

		fireEvent.click(screen.getByRole('button', { name: 'Mapped label' }));

		expect(onChange).toHaveBeenCalledWith('mapped');
	});
});
