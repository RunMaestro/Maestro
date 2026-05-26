import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useModelEffortMenus } from '../../../../../renderer/components/InputArea/hooks/useModelEffortMenus';

function Harness() {
	const {
		modelMenuOpen,
		setModelMenuOpen,
		modelMenuRef,
		effortMenuOpen,
		setEffortMenuOpen,
		effortMenuRef,
	} = useModelEffortMenus();

	return (
		<div>
			<div ref={modelMenuRef} data-testid="model-menu">
				<button onClick={() => setModelMenuOpen(true)}>Open model</button>
				<span>{modelMenuOpen ? 'model-open' : 'model-closed'}</span>
			</div>
			<div ref={effortMenuRef} data-testid="effort-menu">
				<button onClick={() => setEffortMenuOpen(true)}>Open effort</button>
				<span>{effortMenuOpen ? 'effort-open' : 'effort-closed'}</span>
			</div>
			<button>Outside</button>
		</div>
	);
}

describe('useModelEffortMenus', () => {
	it('closes open menus on outside mousedown', () => {
		render(<Harness />);

		fireEvent.click(screen.getByText('Open model'));
		fireEvent.click(screen.getByText('Open effort'));
		expect(screen.getByText('model-open')).toBeInTheDocument();
		expect(screen.getByText('effort-open')).toBeInTheDocument();

		fireEvent.mouseDown(screen.getByText('Outside'));

		expect(screen.getByText('model-closed')).toBeInTheDocument();
		expect(screen.getByText('effort-closed')).toBeInTheDocument();
	});

	it('keeps menu open for inside mousedown', () => {
		render(<Harness />);

		fireEvent.click(screen.getByText('Open model'));
		fireEvent.mouseDown(screen.getByTestId('model-menu'));

		expect(screen.getByText('model-open')).toBeInTheDocument();
	});
});
