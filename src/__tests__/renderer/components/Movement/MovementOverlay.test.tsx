import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MovementOverlay } from '../../../../renderer/components/Movement/MovementOverlay';
import { useMovementStore } from '../../../../renderer/stores/movementStore';
import { mockTheme } from '../../../helpers/mockTheme';

beforeEach(() => {
	useMovementStore.setState({
		items: [],
		viewportWidth: 0,
		viewportHeight: 0,
		hidden: false,
		flashedId: null,
	});
});

describe('MovementOverlay review action', () => {
	it('opens Rehearsal through the allowlisted action and removes the card', () => {
		const onOpenGitReview = vi.fn();
		useMovementStore.getState().upsertItem({
			id: 'review-ready',
			x: 20,
			y: 20,
			width: 380,
			title: 'Review ready: Maestro',
			spec: { blocks: [{ kind: 'text', content: 'Three files need attention.' }] },
			action: { kind: 'open-git-review', sessionId: 'session-1', tabId: 'tab-1' },
			timestamp: 1,
		});

		render(<MovementOverlay theme={mockTheme} onOpenGitReview={onOpenGitReview} />);
		fireEvent.click(screen.getByRole('button', { name: 'Open Rehearsal' }));

		expect(onOpenGitReview).toHaveBeenCalledWith('session-1', 'tab-1');
		expect(useMovementStore.getState().items).toHaveLength(0);
	});
});
