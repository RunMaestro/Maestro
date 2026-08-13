/**
 * Tests for SymphonyModal/components/BuildToolsWarningDialog -
 * the gh-CLI pre-flight state machine (checking → not installed / not
 * authenticated / all clear) and the close vs confirm action paths.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

vi.mock('../../../../../renderer/components/ui/Spinner', () => ({
	Spinner: ({ size }: { size?: number }) => <span data-testid="spinner" data-size={size} />,
}));

vi.mock('lucide-react', () => {
	const icon = (name: string) => {
		const C = () => <svg data-testid={`icon-${name}`} />;
		C.displayName = name;
		return C;
	};
	return {
		AlertCircle: icon('AlertCircle'),
		CheckCircle: icon('CheckCircle'),
	};
});

import { BuildToolsWarningDialog } from '../../../../../renderer/components/SymphonyModal/components/BuildToolsWarningDialog';
import { mockTheme } from '../_fixtures';

const baseProps = {
	theme: mockTheme,
	isOpen: true,
	isChecking: false,
	ghCliStatus: null,
	onConfirm: vi.fn(),
	onClose: vi.fn(),
} as const;

describe('BuildToolsWarningDialog', () => {
	it('renders nothing when isOpen is false', () => {
		const { container } = render(<BuildToolsWarningDialog {...baseProps} isOpen={false} />);
		expect(container.firstChild).toBeNull();
	});

	it('shows the checking spinner when isChecking is true', () => {
		const { getByText, getByTestId } = render(
			<BuildToolsWarningDialog {...baseProps} isChecking />
		);
		expect(getByText('Checking prerequisites…')).toBeTruthy();
		expect(getByTestId('spinner')).toBeTruthy();
	});

	it('shows "GitHub CLI Required" + Close only when gh is not installed', () => {
		const onConfirm = vi.fn();
		const onClose = vi.fn();
		const { getByText, queryByText } = render(
			<BuildToolsWarningDialog
				{...baseProps}
				onConfirm={onConfirm}
				onClose={onClose}
				ghCliStatus={{ installed: false, authenticated: false }}
			/>
		);
		expect(getByText('GitHub CLI Required')).toBeTruthy();
		expect(queryByText('I Have the Build Tools')).toBeNull();
		fireEvent.click(getByText('Close'));
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('shows "GitHub CLI Not Authenticated" + Close only when installed but unauthenticated', () => {
		const onConfirm = vi.fn();
		const onClose = vi.fn();
		const { getByText, queryByText } = render(
			<BuildToolsWarningDialog
				{...baseProps}
				onConfirm={onConfirm}
				onClose={onClose}
				ghCliStatus={{ installed: true, authenticated: false }}
			/>
		);
		expect(getByText('GitHub CLI Not Authenticated')).toBeTruthy();
		expect(queryByText('I Have the Build Tools')).toBeNull();
		fireEvent.click(getByText('Close'));
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('shows the build-tools warning + Confirm button when gh is healthy', () => {
		const onConfirm = vi.fn();
		const { getByText, getByTestId } = render(
			<BuildToolsWarningDialog
				{...baseProps}
				onConfirm={onConfirm}
				ghCliStatus={{ installed: true, authenticated: true }}
			/>
		);
		expect(getByText('GitHub CLI authenticated')).toBeTruthy();
		expect(getByText('Build Tools Required')).toBeTruthy();
		expect(getByTestId('icon-CheckCircle')).toBeTruthy();
		fireEvent.click(getByText('I Have the Build Tools'));
		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it('does not enable confirmation when ghCliStatus is unknown', () => {
		const onConfirm = vi.fn();
		const { getByText, queryByText } = render(
			<BuildToolsWarningDialog {...baseProps} onConfirm={onConfirm} ghCliStatus={null} />
		);
		expect(getByText('Unable to Verify GitHub CLI')).toBeTruthy();
		expect(queryByText('I Have the Build Tools')).toBeNull();
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('Cancel button in the healthy state calls onClose only', () => {
		const onConfirm = vi.fn();
		const onClose = vi.fn();
		const { getByText } = render(
			<BuildToolsWarningDialog
				{...baseProps}
				onConfirm={onConfirm}
				onClose={onClose}
				ghCliStatus={{ installed: true, authenticated: true }}
			/>
		);
		fireEvent.click(getByText('Cancel'));
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it('Backdrop click closes the dialog', () => {
		const onClose = vi.fn();
		const { getByLabelText } = render(
			<BuildToolsWarningDialog
				{...baseProps}
				onClose={onClose}
				ghCliStatus={{ installed: true, authenticated: true }}
			/>
		);
		fireEvent.click(getByLabelText('Close pre-flight check dialog'));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('prefers the "checking" UI even if a previous ghCliStatus is still in state', () => {
		const { getByText, queryByText } = render(
			<BuildToolsWarningDialog
				{...baseProps}
				isChecking
				ghCliStatus={{ installed: true, authenticated: true }}
			/>
		);
		expect(getByText('Checking prerequisites…')).toBeTruthy();
		expect(queryByText('I Have the Build Tools')).toBeNull();
	});
});
