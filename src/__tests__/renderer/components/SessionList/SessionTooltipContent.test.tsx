/**
 * Tests for {@link SessionTooltipContent} - the hover tooltip body that
 * appears for an agent row in the Left Bar. Guards the AUTO pill against
 * accidental re-introduction of pulse animation (see SessionItem AUTO pill
 * tests for the row-level equivalent).
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionTooltipContent } from '../../../../renderer/components/SessionList/SessionTooltipContent';
import type { Session, Theme } from '../../../../renderer/types';
import { createMockSession } from '../../../helpers/mockSession';

vi.mock('lucide-react', () => ({
	Folder: () => <span data-testid="icon-folder" />,
	GitBranch: () => <span data-testid="icon-git-branch" />,
	Bot: () => <span data-testid="icon-bot" />,
	Clock: () => <span data-testid="icon-clock" />,
	Server: () => <span data-testid="icon-server" />,
}));

const theme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentForeground: '#f8f8f2',
		border: '#44475a',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
} as Theme;

const baseSession = (overrides: Partial<Session> = {}): Session =>
	createMockSession({
		cwd: '/home/user/project',
		fullPath: '/home/user/project',
		projectRoot: '/home/user/project',
		isGitRepo: true,
		contextUsage: 30,
		activeTimeMs: 60000,
		...overrides,
	});

describe('SessionTooltipContent AUTO pill', () => {
	it('renders the AUTO pill when isInBatch is true', () => {
		render(<SessionTooltipContent session={baseSession()} theme={theme} isInBatch={true} />);
		expect(screen.getByText('AUTO')).toBeInTheDocument();
	});

	it('does not apply any pulse animation class to the AUTO pill', () => {
		render(<SessionTooltipContent session={baseSession()} theme={theme} isInBatch={true} />);
		const pill = screen.getByText('AUTO').closest('span');
		expect(pill).not.toBeNull();
		expect(pill?.className).not.toMatch(/animate-(pulse|status-pulse|ping|bounce|spin)/);
	});

	it('does not render the AUTO pill when isInBatch is false', () => {
		render(<SessionTooltipContent session={baseSession()} theme={theme} isInBatch={false} />);
		expect(screen.queryByText('AUTO')).not.toBeInTheDocument();
	});
});
