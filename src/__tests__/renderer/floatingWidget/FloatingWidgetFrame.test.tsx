import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FloatingWidgetFrame } from '../../../renderer/floatingWidget/FloatingWidgetFrame';
import { mockTheme } from '../../helpers/mockTheme';

function renderFrame(overrides: Partial<Parameters<typeof FloatingWidgetFrame>[0]> = {}) {
	const onClose = vi.fn();
	render(
		<FloatingWidgetFrame
			theme={mockTheme}
			icon={<span data-testid="widget-icon" />}
			title="Throughput"
			subtitle="All agents"
			actions={
				<button type="button" data-testid="extra-action">
					gear
				</button>
			}
			onClose={onClose}
			closeLabel="Hide gauge"
			{...overrides}
		>
			<div data-testid="widget-body">body</div>
		</FloatingWidgetFrame>
	);
	return { onClose };
}

function appRegion(element: HTMLElement): string {
	return (element.style as unknown as Record<string, string>).WebkitAppRegion ?? '';
}

describe('FloatingWidgetFrame', () => {
	it('renders the icon, title, subtitle and body', () => {
		renderFrame();
		expect(screen.getByTestId('widget-icon')).toBeInTheDocument();
		expect(screen.getByText('Throughput')).toBeInTheDocument();
		expect(screen.getByText('All agents')).toBeInTheDocument();
		expect(screen.getByTestId('widget-body')).toBeInTheDocument();
	});

	it('omits the subtitle when none is given', () => {
		renderFrame({ subtitle: undefined });
		expect(screen.queryByText('All agents')).not.toBeInTheDocument();
	});

	it('fills the window, and stays out of room the window borrowed', () => {
		renderFrame();
		expect(screen.getByTestId('floating-widget-frame').style.top).toBe('0px');
		expect(screen.getByTestId('floating-widget-frame').style.bottom).toBe('0px');
	});

	it('insets the card by the borrowed room so it stays put on screen', () => {
		renderFrame({ insets: { above: 120, below: 0 } });
		expect(screen.getByTestId('floating-widget-frame').style.top).toBe('120px');
		expect(screen.getByTestId('floating-widget-frame').style.bottom).toBe('0px');
	});

	it('is select-none on the root', () => {
		renderFrame();
		expect(screen.getByTestId('floating-widget-frame').className).toContain('select-none');
	});

	it('calls onClose from the close button, which carries the close label', () => {
		const { onClose } = renderFrame();
		const close = screen.getByRole('button', { name: 'Hide gauge' });
		fireEvent.click(close);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('calls onClose on Escape anywhere in the window', () => {
		const { onClose } = renderFrame();
		fireEvent.keyDown(screen.getByTestId('widget-body'), { key: 'Escape' });
		expect(onClose).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it('ignores an Escape a nested surface already handled, and modified Escapes', () => {
		const { onClose } = renderFrame();
		const body = screen.getByTestId('widget-body');
		body.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
		fireEvent.keyDown(body, { key: 'Escape' });
		fireEvent.keyDown(window, { key: 'Escape', metaKey: true });
		fireEvent.keyDown(window, { key: 'Enter' });
		expect(onClose).not.toHaveBeenCalled();
	});

	it('makes the title strip the drag region and its controls no-drag', () => {
		renderFrame();
		expect(appRegion(screen.getByTestId('floating-widget-title-strip'))).toBe('drag');
		expect(appRegion(screen.getByTestId('floating-widget-close'))).toBe('no-drag');
		const actions = screen.getByTestId('extra-action').parentElement as HTMLElement;
		expect(appRegion(actions)).toBe('no-drag');
	});
});
