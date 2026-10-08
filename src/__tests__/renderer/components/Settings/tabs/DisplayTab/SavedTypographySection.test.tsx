import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SavedTypographySection } from '../../../../../../renderer/components/Settings/tabs/DisplayTab/components/SavedTypographySection';
import type { TypographySnapshot } from '../../../../../../shared/typographySnapshot';
import { mockTheme } from '../../../../../helpers/mockTheme';

const SNAPSHOT: TypographySnapshot = {
	savedAt: Date.now() - 60_000,
	fonts: { fontFamily: 'Inter' },
	sizes: { fontSize: 15 },
};

function renderSection(
	props: {
		snapshot?: TypographySnapshot | null;
		isCurrent?: boolean;
	} = {}
) {
	const onSave = vi.fn();
	const onRestore = vi.fn();
	render(
		<SavedTypographySection
			theme={mockTheme}
			snapshot={props.snapshot ?? null}
			isCurrent={props.isCurrent ?? false}
			onSave={onSave}
			onRestore={onRestore}
		/>
	);
	return {
		onSave,
		onRestore,
		save: () => screen.getByTestId('typography-snapshot-save'),
		restore: () => screen.getByTestId('typography-snapshot-restore'),
	};
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('SavedTypographySection', () => {
	it('saves on the first click when there is nothing to overwrite', () => {
		const { onSave, save } = renderSection();
		fireEvent.click(save());
		expect(onSave).toHaveBeenCalledTimes(1);
	});

	it('asks before replacing an existing save, since nothing sits behind it', () => {
		const { onSave, save } = renderSection({ snapshot: SNAPSHOT });
		fireEvent.click(save());
		expect(onSave).not.toHaveBeenCalled();
		expect(save()).toHaveTextContent('Replace your saved fonts?');
		fireEvent.click(save());
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(save()).toHaveTextContent('Save Customizations');
	});

	it('drops the pending confirmation on blur rather than arming it indefinitely', () => {
		const { onSave, save } = renderSection({ snapshot: SNAPSHOT });
		fireEvent.click(save());
		fireEvent.blur(save());
		expect(save()).toHaveTextContent('Save Customizations');
		fireEvent.click(save());
		expect(onSave).not.toHaveBeenCalled();
	});

	it('re-saving an already-active setup needs no confirmation', () => {
		const { onSave, save } = renderSection({ snapshot: SNAPSHOT, isCurrent: true });
		fireEvent.click(save());
		expect(onSave).toHaveBeenCalledTimes(1);
	});

	it('restores in one click, with no confirmation in the way', () => {
		const { onRestore, restore } = renderSection({ snapshot: SNAPSHOT });
		fireEvent.click(restore());
		expect(onRestore).toHaveBeenCalledTimes(1);
	});

	it('offers Restore as disabled rather than hiding it when nothing is saved', () => {
		const { restore } = renderSection();
		expect(restore()).toBeDisabled();
		expect(screen.getByText('Nothing saved yet.')).toBeInTheDocument();
	});

	it('disables Restore while the saved setup is already active', () => {
		const { restore } = renderSection({ snapshot: SNAPSHOT, isCurrent: true });
		expect(restore()).toBeDisabled();
		expect(screen.getByText(/Your saved fonts are active/)).toBeInTheDocument();
	});

	it('says the live fonts are not the saved ones when they have drifted', () => {
		renderSection({ snapshot: SNAPSHOT, isCurrent: false });
		expect(screen.getByText(/The fonts below are not it/)).toBeInTheDocument();
	});
});
