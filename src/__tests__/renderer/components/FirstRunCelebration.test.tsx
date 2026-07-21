import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FirstRunCelebration } from '../../../renderer/components/FirstRunCelebration';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { useModalLayer } from '../../../renderer/hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../../renderer/constants/modalPriorities';
import { createMockTheme } from '../../helpers/mockTheme';

vi.mock('canvas-confetti', () => ({ default: vi.fn() }));

function HigherLayer({ onClose }: { onClose: () => void }) {
	useModalLayer(MODAL_PRIORITIES.STANDING_OVATION + 1, 'Higher layer', onClose);

	useEffect(() => {
		screen.getByRole('dialog', { name: 'Higher layer' }).focus();
	}, []);

	return <div role="dialog" aria-label="Higher layer" tabIndex={-1} />;
}

describe('FirstRunCelebration', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('does not handle keyboard events owned by a higher layer', () => {
		const onCelebrationClose = vi.fn();
		const onHigherLayerClose = vi.fn();

		render(
			<LayerStackProvider>
				<FirstRunCelebration
					theme={createMockTheme()}
					elapsedTimeMs={1_000}
					completedTasks={1}
					totalTasks={1}
					onClose={onCelebrationClose}
					disableConfetti
				/>
				<HigherLayer onClose={onHigherLayerClose} />
			</LayerStackProvider>
		);

		fireEvent.keyDown(screen.getByRole('dialog', { name: 'Higher layer' }), { key: 'Enter' });
		vi.advanceTimersByTime(1_000);

		expect(onCelebrationClose).not.toHaveBeenCalled();
		expect(onHigherLayerClose).not.toHaveBeenCalled();
	});

	it('routes Escape to only the top eligible layer', () => {
		const onCelebrationClose = vi.fn();
		const onHigherLayerClose = vi.fn();

		render(
			<LayerStackProvider>
				<FirstRunCelebration
					theme={createMockTheme()}
					elapsedTimeMs={1_000}
					completedTasks={1}
					totalTasks={1}
					onClose={onCelebrationClose}
					disableConfetti
				/>
				<HigherLayer onClose={onHigherLayerClose} />
			</LayerStackProvider>
		);

		fireEvent.keyDown(screen.getByRole('dialog', { name: 'Higher layer' }), { key: 'Escape' });
		vi.advanceTimersByTime(1_000);

		expect(onHigherLayerClose).toHaveBeenCalledOnce();
		expect(onCelebrationClose).not.toHaveBeenCalled();
	});

	it('closes through the layer stack when it is the top layer', () => {
		const onClose = vi.fn();

		render(
			<LayerStackProvider>
				<FirstRunCelebration
					theme={createMockTheme()}
					elapsedTimeMs={1_000}
					completedTasks={1}
					totalTasks={1}
					onClose={onClose}
					disableConfetti
				/>
			</LayerStackProvider>
		);

		fireEvent.keyDown(screen.getByRole('dialog', { name: 'First Auto Run Celebration' }), {
			key: 'Escape',
		});
		vi.advanceTimersByTime(1_000);

		expect(onClose).toHaveBeenCalledOnce();
	});
});
