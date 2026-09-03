/**
 * `useIsTopLayer` - is this surface the topmost layer right now?
 *
 * The behaviour worth pinning is the flip: a surface that answers an
 * unmodified key has to stop the moment something opens above it, and start
 * again when that closes. Matching is by priority, since `useModalLayer` never
 * hands its layer id back.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useModalLayer } from '../../../../renderer/hooks/ui/useModalLayer';
import { useIsTopLayer } from '../../../../renderer/hooks/ui/useIsTopLayer';

const LOWER = 100;
const UPPER = 200;

function Probe({ priority, label }: { priority: number; label: string }) {
	useModalLayer(priority, label, () => {});
	const isTop = useIsTopLayer(priority);
	return <div data-testid={label}>{isTop ? 'top' : 'covered'}</div>;
}

function renderStack(upperOpen: boolean) {
	return render(
		<LayerStackProvider>
			<Probe priority={LOWER} label="lower" />
			{upperOpen && <Probe priority={UPPER} label="upper" />}
		</LayerStackProvider>
	);
}

describe('useIsTopLayer', () => {
	it('reports true for the only registered layer', () => {
		renderStack(false);
		expect(screen.getByTestId('lower').textContent).toBe('top');
	});

	it('reports false once a higher layer registers, and true again when it goes', () => {
		const { rerender } = renderStack(true);

		expect(screen.getByTestId('lower').textContent).toBe('covered');
		expect(screen.getByTestId('upper').textContent).toBe('top');

		act(() => {
			rerender(
				<LayerStackProvider>
					<Probe priority={LOWER} label="lower" />
				</LayerStackProvider>
			);
		});

		expect(screen.getByTestId('lower').textContent).toBe('top');
	});

	it('reports false for a priority nothing registered', () => {
		function Bystander() {
			return <div data-testid="bystander">{useIsTopLayer(999) ? 'top' : 'covered'}</div>;
		}
		render(
			<LayerStackProvider>
				<Probe priority={LOWER} label="lower" />
				<Bystander />
			</LayerStackProvider>
		);
		expect(screen.getByTestId('bystander').textContent).toBe('covered');
	});
});
