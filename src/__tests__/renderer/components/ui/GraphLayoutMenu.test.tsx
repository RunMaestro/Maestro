import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GraphLayoutMenu } from '../../../../renderer/components/ui/GraphLayoutMenu';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useModalLayer } from '../../../../renderer/hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../../../renderer/constants/modalPriorities';
import { mockTheme } from '../../../helpers/mockTheme';

const options = [
	{ value: 'force', label: 'Force', description: 'Linked nodes' },
	{ value: 'lobes', label: 'Lobes', description: 'Communities' },
	{ value: 'radial', label: 'Radial', description: 'Around a center' },
];

function LayoutPicker({ onChange = vi.fn(), onClose = vi.fn(), value = 'lobes' }) {
	const [open, setOpen] = useState(false);
	useModalLayer(MODAL_PRIORITIES.DELEGATION_GRAPH, 'Graph', onClose);
	return (
		<GraphLayoutMenu
			theme={mockTheme}
			value={value}
			label={options.find((option) => option.value === value)?.label ?? 'Manual'}
			options={options}
			onChange={onChange}
			open={open}
			onOpenChange={setOpen}
			priority={MODAL_PRIORITIES.DELEGATION_GRAPH + 1}
		/>
	);
}

describe('GraphLayoutMenu', () => {
	it('focuses the selected layout, navigates with arrows, and applies with Enter', () => {
		const onChange = vi.fn();
		render(
			<LayerStackProvider>
				<LayoutPicker onChange={onChange} />
			</LayerStackProvider>
		);
		const trigger = screen.getByRole('button', { name: 'Layout' });
		fireEvent.click(trigger);
		expect(trigger).toHaveAttribute('aria-expanded', 'true');
		const lobes = screen.getByRole('menuitemradio', { name: /Lobes/ });
		expect(lobes).toHaveAttribute('aria-checked', 'true');
		expect(lobes).toHaveFocus();
		fireEvent.keyDown(lobes, { key: 'ArrowDown' });
		const radial = screen.getByRole('menuitemradio', { name: /Radial/ });
		expect(radial).toHaveFocus();
		fireEvent.keyDown(radial, { key: 'Enter' });
		expect(onChange).toHaveBeenCalledExactlyOnceWith('radial');
		expect(screen.queryByRole('menu')).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});

	it('closes the menu before its parent on Escape without changing the layout', () => {
		const onClose = vi.fn();
		const onChange = vi.fn();
		render(
			<LayerStackProvider>
				<LayoutPicker onClose={onClose} onChange={onChange} />
			</LayerStackProvider>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Layout' }));
		fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
		expect(screen.queryByRole('menu')).not.toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: 'Layout' })).toHaveFocus();
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('closes on an outside click without applying a layout', () => {
		const onChange = vi.fn();
		render(
			<LayerStackProvider>
				<LayoutPicker onChange={onChange} />
			</LayerStackProvider>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Layout' }));
		fireEvent.mouseDown(document.body);
		expect(screen.queryByRole('menu')).not.toBeInTheDocument();
		expect(onChange).not.toHaveBeenCalled();
	});

	it('keeps Manual as the trigger label and applies an algorithm by click', () => {
		const onChange = vi.fn();
		render(
			<LayerStackProvider>
				<LayoutPicker value="manual" onChange={onChange} />
			</LayerStackProvider>
		);
		expect(screen.getByRole('button', { name: 'Layout' })).toHaveTextContent('Manual');
		fireEvent.click(screen.getByRole('button', { name: 'Layout' }));
		expect(screen.getAllByRole('menuitemradio')).toHaveLength(3);
		fireEvent.click(screen.getByRole('menuitemradio', { name: /Force/ }));
		expect(onChange).toHaveBeenCalledExactlyOnceWith('force');
	});
});
