/**
 * Tests for ScreenReaderAnnouncement component
 *
 * Tests the accessibility announcement component used in the wizard
 * for screen reader notifications.
 */

import { render, screen, act } from '@testing-library/react';
import {
	ScreenReaderAnnouncement,
	useAnnouncement,
} from '../../../../renderer/components/Wizard/ScreenReaderAnnouncement';

describe('ScreenReaderAnnouncement', () => {
	describe('Component rendering', () => {
		it('renders announcement message in an aria-live region', () => {
			render(<ScreenReaderAnnouncement message="Test announcement" />);

			// Should have two live regions (for toggle functionality)
			const liveRegions = screen.getAllByRole('status');
			expect(liveRegions).toHaveLength(2);

			// One of them should contain the message
			const hasMessage = liveRegions.some((region) =>
				region.textContent?.includes('Test announcement')
			);
			expect(hasMessage).toBe(true);
		});

		it('uses polite politeness by default', () => {
			render(<ScreenReaderAnnouncement message="Test message" />);

			const liveRegions = screen.getAllByRole('status');
			liveRegions.forEach((region) => {
				expect(region).toHaveAttribute('aria-live', 'polite');
			});
		});

		it('uses assertive politeness when specified', () => {
			render(<ScreenReaderAnnouncement message="Urgent message" politeness="assertive" />);

			const liveRegions = screen.getAllByRole('status');
			liveRegions.forEach((region) => {
				expect(region).toHaveAttribute('aria-live', 'assertive');
			});
		});

		it('uses aria-atomic for complete announcements', () => {
			render(<ScreenReaderAnnouncement message="Complete message" />);

			const liveRegions = screen.getAllByRole('status');
			liveRegions.forEach((region) => {
				expect(region).toHaveAttribute('aria-atomic', 'true');
			});
		});

		it('is visually hidden but accessible', () => {
			render(<ScreenReaderAnnouncement message="Hidden message" />);

			const liveRegions = screen.getAllByRole('status');
			liveRegions.forEach((region) => {
				// Check for visually hidden styles
				const style = window.getComputedStyle(region);
				expect(region).toHaveStyle({ position: 'absolute' });
				expect(region).toHaveStyle({ width: '1px' });
				expect(region).toHaveStyle({ height: '1px' });
			});
		});
	});

	describe('Message toggling', () => {
		it('toggles message between regions when announceKey changes', () => {
			const { rerender } = render(
				<ScreenReaderAnnouncement message="First message" announceKey={1} />
			);

			const liveRegions = screen.getAllByRole('status');
			const initialState = liveRegions.map((r) => r.textContent);

			// Change the key to trigger toggle
			rerender(<ScreenReaderAnnouncement message="Second message" announceKey={2} />);

			// Message should have moved to the other region
			const newState = liveRegions.map((r) => r.textContent);
			expect(newState).not.toEqual(initialState);
		});

		it('re-announces the same message when announceKey changes', () => {
			const { rerender } = render(
				<ScreenReaderAnnouncement message="Same message" announceKey={1} />
			);

			const liveRegions = screen.getAllByRole('status');
			const getActiveRegion = () => liveRegions.find((r) => r.textContent === 'Same message');

			const firstActiveRegion = getActiveRegion();

			// Change key but keep same message
			rerender(<ScreenReaderAnnouncement message="Same message" announceKey={2} />);

			const secondActiveRegion = getActiveRegion();

			// The message should toggle to the other region
			expect(secondActiveRegion).not.toBe(firstActiveRegion);
		});
	});

	describe('Empty state', () => {
		it('renders empty regions when message is empty', () => {
			render(<ScreenReaderAnnouncement message="" />);

			const liveRegions = screen.getAllByRole('status');
			liveRegions.forEach((region) => {
				expect(region.textContent).toBe('');
			});
		});
	});
});

describe('useAnnouncement hook', () => {
	// Helper component to test the hook
	function TestComponent() {
		const { announce, announcementProps } = useAnnouncement(0); // No debounce for testing

		return (
			<div>
				<button onClick={() => announce('Test announcement')}>Announce</button>
				<ScreenReaderAnnouncement {...announcementProps} />
			</div>
		);
	}

	it('provides announce function and props', () => {
		render(<TestComponent />);

		const button = screen.getByText('Announce');
		expect(button).toBeInTheDocument();

		// Initially should have empty message
		const liveRegions = screen.getAllByRole('status');
		liveRegions.forEach((region) => {
			expect(region.textContent).toBe('');
		});
	});

	it('updates announcement when announce is called', async () => {
		render(<TestComponent />);

		const button = screen.getByText('Announce');

		await act(async () => {
			button.click();
			// Wait for state update
			await new Promise((resolve) => setTimeout(resolve, 10));
		});

		const liveRegions = screen.getAllByRole('status');
		const hasAnnouncement = liveRegions.some((region) =>
			region.textContent?.includes('Test announcement')
		);
		expect(hasAnnouncement).toBe(true);
	});
});
