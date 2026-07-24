/**
 * Tests for CollapsedCommandsNotice component
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CollapsedCommandsNotice } from '../../../../renderer/components/ui/CollapsedCommandsNotice';
import { mockTheme } from '../../../helpers/mockTheme';

describe('CollapsedCommandsNotice', () => {
	it('pluralizes the hidden-command count and offers to reveal', () => {
		render(
			<CollapsedCommandsNotice
				theme={mockTheme}
				count={3}
				expanded={false}
				onToggle={vi.fn()}
				sectionName="Spec Kit"
			/>
		);
		expect(screen.getByText('3 Spec Kit commands hidden')).toBeInTheDocument();
		expect(screen.getByText('Show anyway')).toBeInTheDocument();
	});

	it('uses the singular noun for a single command', () => {
		render(
			<CollapsedCommandsNotice
				theme={mockTheme}
				count={1}
				expanded={false}
				onToggle={vi.fn()}
				sectionName="BMAD"
			/>
		);
		expect(screen.getByText('1 BMAD command hidden')).toBeInTheDocument();
	});

	it('shows the collapse affordance and aria-expanded when expanded', () => {
		render(
			<CollapsedCommandsNotice
				theme={mockTheme}
				count={2}
				expanded={true}
				onToggle={vi.fn()}
				sectionName="OpenSpec"
			/>
		);
		expect(screen.getByText('Collapse')).toBeInTheDocument();
		expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
	});

	it('fires onToggle when clicked', () => {
		const onToggle = vi.fn();
		render(
			<CollapsedCommandsNotice
				theme={mockTheme}
				count={2}
				expanded={false}
				onToggle={onToggle}
				sectionName="Spec Kit"
			/>
		);
		fireEvent.click(screen.getByRole('button'));
		expect(onToggle).toHaveBeenCalledTimes(1);
	});
});
