import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { THEMES } from '../../../constants/themes';
import { NotificationSendControls } from './NotificationSendControls';

describe('NotificationSendControls OMP delivery', () => {
	it('keeps idle send ordinary', () => {
		const processInput = vi.fn();
		render(
			<NotificationSendControls
				theme={THEMES.dracula}
				isTerminalMode={false}
				processInput={processInput}
			/>
		);
		fireEvent.click(screen.getByTitle('Send message'));
		expect(processInput).toHaveBeenCalledOnce();
		expect(
			screen.queryByRole('button', { name: 'Choose OMP delivery mode' })
		).not.toBeInTheDocument();
	});

	it('offers all native delivery operations with keyboard accessible menu behavior', () => {
		const onOmpDelivery = vi.fn();
		render(
			<NotificationSendControls
				theme={THEMES.dracula}
				isTerminalMode={false}
				processInput={vi.fn()}
				ompBusy
				onOmpDelivery={onOmpDelivery}
			/>
		);
		const trigger = screen.getByRole('button', { name: 'Choose OMP delivery mode' });
		fireEvent.keyDown(trigger, { key: 'ArrowDown' });
		expect(screen.getByRole('menu', { name: 'OMP delivery mode' })).toBeInTheDocument();
		expect(screen.getByRole('menuitem', { name: /Steer now/ })).toBeInTheDocument();
		const followUp = screen.getByRole('menuitem', { name: /Queue follow-up/ });
		fireEvent.click(followUp);
		expect(onOmpDelivery).toHaveBeenCalledWith('follow_up');
		expect(screen.queryByRole('menu')).not.toBeInTheDocument();
		fireEvent.click(trigger);
		fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
		expect(document.activeElement).toBe(trigger);
	});
});
