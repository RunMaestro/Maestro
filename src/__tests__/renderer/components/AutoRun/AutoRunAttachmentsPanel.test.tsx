import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
	AutoRunAttachmentsPanel,
	AutoRunAttachmentsPanelProps,
} from '../../../../renderer/components/AutoRun/AutoRunAttachmentsPanel';

vi.mock('lucide-react', async () => {
	const actual = await vi.importActual<typeof import('lucide-react')>('lucide-react');
	return {
		...actual,
		ChevronDown: (props: any) => <svg data-testid="chevron-down" {...props} />,
		ChevronRight: (props: any) => <svg data-testid="chevron-right" {...props} />,
	};
});

vi.mock('../../../../renderer/components/AutoRun/AttachmentImage', () => ({
	ImagePreview: ({ filename, onRemove, onImageClick }: any) => (
		<div data-testid={`image-preview-${filename}`}>
			<span>{filename}</span>
			<button data-testid={`remove-${filename}`} onClick={onRemove}>
				Remove
			</button>
			<button data-testid={`click-${filename}`} onClick={() => onImageClick(filename)}>
				Click
			</button>
		</div>
	),
}));

const createMockTheme = () => ({
	id: 'test',
	name: 'Test',
	mode: 'dark' as const,
	colors: {
		bgMain: '#1a1a1a',
		bgPanel: '#252525',
		bgActivity: '#2d2d2d',
		textMain: '#fff',
		textDim: '#888',
		accent: '#0066ff',
		accentForeground: '#fff',
		border: '#333',
		highlight: '#0066ff33',
		success: '#0a0',
		warning: '#fa0',
		error: '#f00',
	},
});

const defaultProps: AutoRunAttachmentsPanelProps = {
	theme: createMockTheme() as any,
	attachmentsList: ['image1.png', 'image2.jpg'],
	attachmentPreviews: new Map([
		['image1.png', 'data:image/png;base64,abc'],
		['image2.jpg', 'data:image/jpeg;base64,def'],
	]),
	attachmentsExpanded: true,
	onToggleExpanded: vi.fn(),
	onRemoveAttachment: vi.fn(),
	onImageClick: vi.fn(),
};

function renderPanel(overrides: Partial<AutoRunAttachmentsPanelProps> = {}) {
	return render(<AutoRunAttachmentsPanel {...defaultProps} {...overrides} />);
}

describe('AutoRunAttachmentsPanel', () => {
	it('returns null when attachmentsList is empty', () => {
		const { container } = renderPanel({ attachmentsList: [] });
		expect(container.innerHTML).toBe('');
	});

	it('shows "Attached Images (N)" text with correct count', () => {
		renderPanel();
		expect(screen.getByText('Attached Images (2)')).toBeInTheDocument();
	});

	it('shows correct count for a single attachment', () => {
		renderPanel({
			attachmentsList: ['only.png'],
			attachmentPreviews: new Map([['only.png', 'data:x']]),
		});
		expect(screen.getByText('Attached Images (1)')).toBeInTheDocument();
	});

	it('shows chevron-down when expanded', () => {
		renderPanel({ attachmentsExpanded: true });
		expect(screen.getByTestId('chevron-down')).toBeInTheDocument();
		expect(screen.queryByTestId('chevron-right')).not.toBeInTheDocument();
	});

	it('shows chevron-right when collapsed', () => {
		renderPanel({ attachmentsExpanded: false });
		expect(screen.getByTestId('chevron-right')).toBeInTheDocument();
		expect(screen.queryByTestId('chevron-down')).not.toBeInTheDocument();
	});

	it('clicking toggle button calls onToggleExpanded', () => {
		const onToggleExpanded = vi.fn();
		renderPanel({ onToggleExpanded });
		fireEvent.click(screen.getByText('Attached Images (2)'));
		expect(onToggleExpanded).toHaveBeenCalledTimes(1);
	});

	it('shows image previews when expanded', () => {
		renderPanel({ attachmentsExpanded: true });
		expect(screen.getByTestId('image-preview-image1.png')).toBeInTheDocument();
		expect(screen.getByTestId('image-preview-image2.jpg')).toBeInTheDocument();
	});

	it('hides image previews when collapsed', () => {
		renderPanel({ attachmentsExpanded: false });
		expect(screen.queryByTestId('image-preview-image1.png')).not.toBeInTheDocument();
		expect(screen.queryByTestId('image-preview-image2.jpg')).not.toBeInTheDocument();
	});

	it('each image preview has correct filename', () => {
		renderPanel({ attachmentsExpanded: true });
		expect(screen.getByText('image1.png')).toBeInTheDocument();
		expect(screen.getByText('image2.jpg')).toBeInTheDocument();
	});

	it('calls onRemoveAttachment with correct filename when remove is clicked', () => {
		const onRemoveAttachment = vi.fn();
		renderPanel({ attachmentsExpanded: true, onRemoveAttachment });
		fireEvent.click(screen.getByTestId('remove-image1.png'));
		expect(onRemoveAttachment).toHaveBeenCalledWith('image1.png');
	});

	it('calls onImageClick with correct filename when image is clicked', () => {
		const onImageClick = vi.fn();
		renderPanel({ attachmentsExpanded: true, onImageClick });
		fireEvent.click(screen.getByTestId('click-image2.jpg'));
		expect(onImageClick).toHaveBeenCalledWith('image2.jpg');
	});
});
