import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModelEffortPills } from '../../../../../renderer/components/InputArea/components/ModelEffortPills';
import { inputAreaTheme } from '../_fixtures';

describe('ModelEffortPills', () => {
	function renderPills(overrides = {}) {
		return render(
			<ModelEffortPills
				isVisible
				theme={inputAreaTheme}
				currentModel="gpt-5"
				currentEffort="medium"
				availableModels={['gpt-5', 'gpt-5-mini']}
				availableEfforts={['', 'low', 'medium']}
				onModelChange={vi.fn()}
				onEffortChange={vi.fn()}
				modelMenuOpen={false}
				setModelMenuOpen={vi.fn()}
				modelMenuRef={{ current: null }}
				effortMenuOpen={false}
				setEffortMenuOpen={vi.fn()}
				effortMenuRef={{ current: null }}
				{...overrides}
			/>
		);
	}

	it('renders nothing when not visible', () => {
		renderPills({ isVisible: false });

		expect(screen.queryByTitle('Change model')).not.toBeInTheDocument();
	});

	it('opens model menu and closes effort menu when model pill is clicked', () => {
		const setModelMenuOpen = vi.fn();
		const setEffortMenuOpen = vi.fn();
		renderPills({ setModelMenuOpen, setEffortMenuOpen });

		fireEvent.click(screen.getByTitle('Change model'));

		expect(setModelMenuOpen).toHaveBeenCalledWith(true);
		expect(setEffortMenuOpen).toHaveBeenCalledWith(false);
	});

	it('renders default model option and selects a model', () => {
		const onModelChange = vi.fn();
		const setModelMenuOpen = vi.fn();
		renderPills({ modelMenuOpen: true, onModelChange, setModelMenuOpen });

		fireEvent.click(screen.getByText('gpt-5-mini'));

		expect(screen.getByText('(default)')).toBeInTheDocument();
		expect(onModelChange).toHaveBeenCalledWith('gpt-5-mini');
		expect(setModelMenuOpen).toHaveBeenCalledWith(false);
	});

	it('hides effort pill when only default effort exists', () => {
		renderPills({ availableEfforts: [''] });

		expect(screen.queryByTitle('Change effort level')).not.toBeInTheDocument();
	});

	it('selects an effort and closes the menu', () => {
		const onEffortChange = vi.fn();
		const setEffortMenuOpen = vi.fn();
		renderPills({ effortMenuOpen: true, onEffortChange, setEffortMenuOpen });

		fireEvent.click(screen.getByText('low'));

		expect(onEffortChange).toHaveBeenCalledWith('low');
		expect(setEffortMenuOpen).toHaveBeenCalledWith(false);
	});
});
