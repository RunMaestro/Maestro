import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SshRemoteIgnoreSection } from '../../../../renderer/components/Settings/SshRemoteIgnoreSection';
import type { Theme } from '../../../../renderer/types';

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

function renderSection(
	overrides: Partial<React.ComponentProps<typeof SshRemoteIgnoreSection>> = {}
) {
	const props: React.ComponentProps<typeof SshRemoteIgnoreSection> = {
		theme,
		ignorePatterns: ['node_modules', 'build'],
		onIgnorePatternsChange: vi.fn(),
		honorGitignore: true,
		onHonorGitignoreChange: vi.fn(),
		...overrides,
	};

	return {
		...render(<SshRemoteIgnoreSection {...props} />),
		props,
	};
}

describe('SshRemoteIgnoreSection', () => {
	it('renders SSH-specific copy and forwards pattern and gitignore state', () => {
		const onHonorGitignoreChange = vi.fn();
		renderSection({ onHonorGitignoreChange });

		expect(screen.getByText('Remote Ignore Patterns')).toBeInTheDocument();
		expect(
			screen.getByText(
				'Configure glob patterns for folders to exclude when indexing remote files via SSH. These patterns apply to all SSH connections.'
			)
		).toBeInTheDocument();
		expect(screen.getByText('node_modules')).toBeInTheDocument();
		expect(screen.getByText('build')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('checkbox', { name: /honor \.gitignore/i }));

		expect(onHonorGitignoreChange).toHaveBeenCalledWith(false);
	});

	it('resets to SSH defaults and restores honoring remote gitignore files', () => {
		const onIgnorePatternsChange = vi.fn();
		const onHonorGitignoreChange = vi.fn();
		renderSection({
			honorGitignore: false,
			onHonorGitignoreChange,
			onIgnorePatternsChange,
		});

		fireEvent.click(
			screen.getByRole('button', { name: 'Reset Remote Ignore Patterns to defaults' })
		);

		expect(onIgnorePatternsChange).toHaveBeenCalledWith(['.git', '*cache*']);
		expect(onHonorGitignoreChange).toHaveBeenCalledWith(true);
	});
});
