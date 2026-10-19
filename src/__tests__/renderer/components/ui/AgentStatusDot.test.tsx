/**
 * Tests for AgentStatusDot - the Left Bar's agent status dot, shared with the
 * tab window header.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentStatusDot } from '../../../../renderer/components/ui/AgentStatusDot';
import { THEMES } from '../../../../renderer/constants/themes';

const theme = THEMES.dracula;

function renderDot(props: Partial<React.ComponentProps<typeof AgentStatusDot>> = {}) {
	return render(
		<AgentStatusDot
			theme={theme}
			color="#00ff00"
			animate={false}
			hollow={false}
			title="Ready"
			{...props}
		/>
	);
}

describe('AgentStatusDot', () => {
	it('fills with the status color and carries the label as its tooltip', () => {
		renderDot();
		const dot = screen.getByTestId('agent-status-dot');
		expect(dot).toHaveStyle({ backgroundColor: '#00ff00' });
		expect(dot).toHaveAttribute('title', 'Ready');
	});

	it('draws a pulse ring only while animated', () => {
		const { container, rerender } = renderDot();
		expect(container.querySelector('.animate-ping')).toBeNull();
		rerender(
			<AgentStatusDot theme={theme} color="#ffff00" animate hollow={false} title="Thinking" />
		);
		expect(container.querySelector('.animate-ping')).not.toBeNull();
	});

	it('draws an outline instead of a fill when hollow', () => {
		renderDot({ hollow: true });
		const dot = screen.getByTestId('agent-status-dot');
		expect(dot.style.backgroundColor).toBe('transparent');
		expect(dot.style.border).toContain('1.5px solid');
	});

	it('renders children inside its box, for a corner badge', () => {
		renderDot({ children: <span data-testid="badge" />, className: 'ml-auto' });
		const badge = screen.getByTestId('badge');
		expect(badge.parentElement?.className).toContain('ml-auto');
	});
});
