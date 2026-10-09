/**
 * Review annotations in the Git Diff viewer, driven through the REAL diff
 * renderer and parser: click a line number, write a comment, batch it in the
 * tray, and send the batch as one prompt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { GitDiffViewer } from '../../../renderer/components/GitDiffViewer';
import { setPendingDiffAnnotations } from '../../../renderer/services/diffReview';
import { mockTheme } from '../../helpers/mockTheme';

const mockRegisterLayer = vi.fn(() => 'layer-1');
const mockUpdateLayerHandler = vi.fn();
vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: vi.fn(),
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));
vi.mock('react-diff-view/style/index.css', () => ({}));

const DIFF = [
	'diff --git a/src/app.ts b/src/app.ts',
	'index 1111111..2222222 100644',
	'--- a/src/app.ts',
	'+++ b/src/app.ts',
	'@@ -1,3 +1,3 @@',
	' const keep = 1;',
	'-const old = 2;',
	'+const fresh = 3;',
	' const tail = 4;',
	'',
].join('\n');

const CWD = '/repo';

function renderViewer(onSendReview = vi.fn(() => true), onClose = vi.fn()) {
	render(
		<GitDiffViewer
			diffText={DIFF}
			cwd={CWD}
			theme={mockTheme}
			onClose={onClose}
			onSendReview={onSendReview}
			reviewTargetName="Builder"
		/>
	);
	return { onSendReview, onClose };
}

/** The gutter cell holding `lineNumber` for the row whose code is `code`. */
function gutterFor(code: string): HTMLElement {
	const codeCell = screen.getByText(code).closest('td');
	const row = codeCell?.closest('tr');
	const gutter = row?.querySelector('td.diff-gutter:not(.diff-gutter-omit)');
	if (!gutter) throw new Error(`no gutter for ${code}`);
	return gutter as HTMLElement;
}

function annotate(code: string, body: string) {
	fireEvent.click(gutterFor(code));
	fireEvent.change(screen.getByLabelText('Annotation'), { target: { value: body } });
	fireEvent.click(screen.getByRole('button', { name: 'Add annotation' }));
}

describe('GitDiffViewer annotations', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setPendingDiffAnnotations(CWD, []);
	});

	it('opens an editor under a clicked line and saves the comment as a card', () => {
		renderViewer();
		annotate('const fresh = 3;', 'Rename this.');
		expect(screen.queryByLabelText('Annotation')).not.toBeInTheDocument();
		expect(screen.getByTestId('diff-annotation-card')).toHaveTextContent('Rename this.');
		const tray = screen.getByTestId('diff-review-tray');
		expect(tray).toHaveTextContent('Review: 1 annotation');
		expect(tray).toHaveTextContent('src/app.ts:2');
	});

	it('sends every annotation as one prompt, then clears and closes', () => {
		const { onSendReview, onClose } = renderViewer();
		annotate('const fresh = 3;', 'Rename this.');
		annotate('const old = 2;', 'Why remove it?');

		fireEvent.click(screen.getByRole('button', { name: 'Send review to Builder' }));

		expect(onSendReview).toHaveBeenCalledTimes(1);
		const prompt = onSendReview.mock.calls[0][0] as string;
		expect(prompt).toContain('src/app.ts:2 (previous version)');
		expect(prompt).toContain('> const old = 2;');
		expect(prompt).toContain('src/app.ts:2\n');
		expect(prompt).toContain('Rename this.');
		expect(onClose).toHaveBeenCalled();
	});

	it('keeps the annotations when the review could not be delivered', () => {
		const { onClose } = renderViewer(vi.fn(() => false));
		annotate('const fresh = 3;', 'Rename this.');
		fireEvent.click(screen.getByRole('button', { name: 'Send review to Builder' }));
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByTestId('diff-review-tray')).toBeInTheDocument();
	});

	it('edits and removes annotations from the tray', () => {
		renderViewer();
		annotate('const fresh = 3;', 'First draft.');
		const tray = screen.getByTestId('diff-review-tray');

		fireEvent.click(within(tray).getByText('First draft.'));
		const editor = screen.getByLabelText('Annotation');
		expect(editor).toHaveValue('First draft.');
		fireEvent.change(editor, { target: { value: 'Second draft.' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(screen.getByTestId('diff-annotation-card')).toHaveTextContent('Second draft.');

		fireEvent.click(
			within(screen.getByTestId('diff-review-tray')).getByRole('button', {
				name: 'Remove annotation on src/app.ts:2',
			})
		);
		expect(screen.queryByTestId('diff-review-tray')).not.toBeInTheDocument();
	});

	it('Escape dismisses an open editor before it closes the viewer', () => {
		const { onClose } = renderViewer();
		fireEvent.click(gutterFor('const fresh = 3;'));
		expect(screen.getByLabelText('Annotation')).toBeInTheDocument();

		const { onEscape } = mockRegisterLayer.mock.calls[0][0] as unknown as {
			onEscape: () => void;
		};
		act(() => onEscape());
		expect(screen.queryByLabelText('Annotation')).not.toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();

		// With no editor open, Escape closes the viewer as before.
		act(() => onEscape());
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('restores pending annotations when the viewer is reopened for the same repo', () => {
		const first = renderViewer();
		annotate('const fresh = 3;', 'Keep me.');
		first.onClose.mockClear();
		document.body.innerHTML = '';
		renderViewer();
		expect(screen.getByTestId('diff-review-tray')).toHaveTextContent('Keep me.');
	});

	it('offers no annotation affordance without a send target', () => {
		render(<GitDiffViewer diffText={DIFF} cwd={CWD} theme={mockTheme} onClose={vi.fn()} />);
		fireEvent.click(gutterFor('const fresh = 3;'));
		expect(screen.queryByLabelText('Annotation')).not.toBeInTheDocument();
	});
});
