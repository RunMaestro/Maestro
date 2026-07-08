import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LucideIcon } from 'lucide-react';
import { IgnorePatternsSection } from '../../renderer/components/Settings/IgnorePatternsSection';
import type { Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#111827',
		bgSidebar: '#1f2937',
		bgActivity: '#374151',
		textMain: '#f9fafb',
		textDim: '#9ca3af',
		accent: '#2563eb',
		accentForeground: '#ffffff',
		border: '#4b5563',
		error: '#ef4444',
		success: '#10b981',
		warning: '#f59e0b',
		info: '#38bdf8',
		textInverse: '#020617',
	},
};

const defaultPatterns = ['.git', 'node_modules', '*.log'];

function renderSection(
	overrides: Partial<React.ComponentProps<typeof IgnorePatternsSection>> = {}
) {
	const props: React.ComponentProps<typeof IgnorePatternsSection> = {
		theme,
		title: 'Local Ignore Patterns',
		description: 'Configure folders that should be skipped during indexing.',
		ignorePatterns: ['node_modules', 'dist'],
		onIgnorePatternsChange: vi.fn(),
		defaultPatterns,
		...overrides,
	};

	return {
		...render(<IgnorePatternsSection {...props} />),
		props,
	};
}

describe('IgnorePatternsSection', () => {
	it('renders configured patterns and removes a selected pattern', () => {
		const onIgnorePatternsChange = vi.fn();
		renderSection({ onIgnorePatternsChange });

		expect(screen.getByText('File Indexing')).toBeInTheDocument();
		expect(screen.getByText('Local Ignore Patterns')).toBeInTheDocument();
		expect(
			screen.getByText('Configure folders that should be skipped during indexing.')
		).toBeInTheDocument();
		expect(screen.getByText('Active patterns:')).toBeInTheDocument();
		expect(screen.getByText('node_modules')).toBeInTheDocument();
		expect(screen.getByText('dist')).toBeInTheDocument();

		fireEvent.click(screen.getAllByTitle('Remove pattern')[0]);

		expect(onIgnorePatternsChange).toHaveBeenCalledWith(['dist']);
	});

	it('adds trimmed patterns with the button and Enter key', () => {
		const onIgnorePatternsChange = vi.fn();
		const { rerender, props } = renderSection({ ignorePatterns: ['dist'], onIgnorePatternsChange });
		const input = screen.getByPlaceholderText('Enter glob pattern (e.g., node_modules, *.log)');
		const addButton = screen.getByRole('button', { name: /add/i });

		expect(addButton).toBeDisabled();

		fireEvent.change(input, { target: { value: '  coverage  ' } });
		fireEvent.click(addButton);

		expect(onIgnorePatternsChange).toHaveBeenCalledWith(['dist', 'coverage']);
		expect(input).toHaveValue('');

		rerender(<IgnorePatternsSection {...props} ignorePatterns={['dist', 'coverage']} />);
		fireEvent.change(
			screen.getByPlaceholderText('Enter glob pattern (e.g., node_modules, *.log)'),
			{
				target: { value: 'tmp' },
			}
		);
		fireEvent.keyDown(
			screen.getByPlaceholderText('Enter glob pattern (e.g., node_modules, *.log)'),
			{
				key: 'Enter',
			}
		);

		expect(onIgnorePatternsChange).toHaveBeenLastCalledWith(['dist', 'coverage', 'tmp']);
	});

	it('does not add a pattern when non-Enter keys are pressed', () => {
		const onIgnorePatternsChange = vi.fn();
		renderSection({ ignorePatterns: ['dist'], onIgnorePatternsChange });
		const input = screen.getByPlaceholderText('Enter glob pattern (e.g., node_modules, *.log)');

		fireEvent.change(input, { target: { value: 'coverage' } });
		fireEvent.keyDown(input, { key: 'Escape' });

		expect(onIgnorePatternsChange).not.toHaveBeenCalled();
		expect(input).toHaveValue('coverage');
	});

	it('shows validation errors for empty and duplicate patterns, then clears the error on change', () => {
		const onIgnorePatternsChange = vi.fn();
		renderSection({ ignorePatterns: ['dist'], onIgnorePatternsChange });
		const input = screen.getByPlaceholderText('Enter glob pattern (e.g., node_modules, *.log)');

		fireEvent.keyDown(input, { key: 'Enter' });
		expect(screen.getByText('Pattern cannot be empty')).toBeInTheDocument();
		expect(onIgnorePatternsChange).not.toHaveBeenCalled();

		fireEvent.change(input, { target: { value: 'dist' } });
		expect(screen.queryByText('Pattern cannot be empty')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /add/i }));
		expect(screen.getByText('Pattern already exists')).toBeInTheDocument();
		expect(onIgnorePatternsChange).not.toHaveBeenCalled();
	});

	it('renders an empty state when no ignore patterns are configured', () => {
		renderSection({ ignorePatterns: [] });

		expect(
			screen.getByText('No ignore patterns configured. All folders will be indexed.')
		).toBeInTheDocument();
		expect(screen.queryByText('Active patterns:')).not.toBeInTheDocument();
	});

	it('resets to defaults and invokes the optional reset callback', () => {
		const onIgnorePatternsChange = vi.fn();
		const onReset = vi.fn();
		renderSection({ onIgnorePatternsChange, onReset });

		fireEvent.click(
			screen.getByRole('button', { name: 'Reset Local Ignore Patterns to defaults' })
		);

		expect(onIgnorePatternsChange).toHaveBeenCalledWith(defaultPatterns);
		expect(onReset).toHaveBeenCalledOnce();
	});

	it('resets to defaults without requiring an optional reset callback', () => {
		const onIgnorePatternsChange = vi.fn();
		renderSection({ onIgnorePatternsChange, onReset: undefined });

		fireEvent.click(
			screen.getByRole('button', { name: 'Reset Local Ignore Patterns to defaults' })
		);

		expect(onIgnorePatternsChange).toHaveBeenCalledWith(defaultPatterns);
	});

	it('toggles the honor gitignore checkbox when enabled', () => {
		const onHonorGitignoreChange = vi.fn();
		renderSection({
			showHonorGitignore: true,
			honorGitignore: false,
			onHonorGitignoreChange,
		});

		const checkbox = screen.getByRole('checkbox', { name: /honor \.gitignore/i });
		expect(checkbox).toHaveAttribute('aria-checked', 'false');

		fireEvent.click(checkbox);

		expect(onHonorGitignoreChange).toHaveBeenCalledWith(true);
		expect(
			screen.getByText(
				'When enabled, patterns from .gitignore files will also be excluded from indexing.'
			)
		).toBeInTheDocument();
	});

	it('renders checked honor gitignore state and hides it when the callback is absent', () => {
		const { rerender, props } = renderSection({
			showHonorGitignore: true,
			honorGitignore: true,
			onHonorGitignoreChange: vi.fn(),
		});

		expect(screen.getByRole('checkbox', { name: /honor \.gitignore/i })).toHaveAttribute(
			'aria-checked',
			'true'
		);

		rerender(
			<IgnorePatternsSection
				{...props}
				showHonorGitignore
				honorGitignore
				onHonorGitignoreChange={undefined}
			/>
		);

		expect(screen.queryByRole('checkbox', { name: /honor \.gitignore/i })).not.toBeInTheDocument();
	});

	it('accepts a custom icon component', () => {
		const CustomIcon: LucideIcon = (props) => <svg data-testid="custom-ignore-icon" {...props} />;

		renderSection({ icon: CustomIcon });

		expect(screen.getByTestId('custom-ignore-icon')).toBeInTheDocument();
	});
});
