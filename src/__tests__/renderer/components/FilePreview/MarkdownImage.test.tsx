import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MarkdownImage } from '../../../../renderer/components/FilePreview/MarkdownImage';
import { imageCache } from '../../../../renderer/components/FilePreview/filePreviewUtils';
import { mockTheme } from '../../../helpers/mockTheme';

const readFile = vi.mocked(window.maestro.fs.readFile);
const stat = vi.mocked(window.maestro.fs.stat);

describe('MarkdownImage', () => {
	beforeEach(() => {
		imageCache.clear();
		readFile.mockReset();
		stat.mockReset();
	});

	it('loads a vault-root image after the note-relative reading misses', async () => {
		readFile.mockImplementation(async (path: string) =>
			path === '/vault/Body/_attachments/a b.jpg' ? 'data:image/jpeg;base64,AAAA' : null
		);
		render(
			<MarkdownImage
				src="Body/_attachments/a%20b.jpg"
				alt="Caption|220"
				markdownFilePath="/vault/Body/note.md"
				projectRoot="/vault"
				theme={mockTheme}
			/>
		);

		const img = await screen.findByAltText('Caption');
		expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
		expect(img.style.width).toBe('220px');
		expect(readFile).toHaveBeenNthCalledWith(1, '/vault/Body/Body/_attachments/a b.jpg', undefined);
	});

	it('says the image is missing instead of calling it invalid', async () => {
		readFile.mockResolvedValue(null);
		render(
			<MarkdownImage
				src="missing.png"
				markdownFilePath="/vault/note.md"
				projectRoot="/vault"
				theme={mockTheme}
			/>
		);
		expect(await screen.findByText('Image not found: missing.png')).toBeTruthy();
	});

	it('renders media as a chip that opens the resolved file', async () => {
		stat.mockImplementation(async (path: string) => {
			if (path === '/vault/clip.mp4') return { size: 1 } as any;
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		});
		const onOpenFile = vi.fn();
		render(
			<MarkdownImage
				src="clip.mp4"
				alt="Demo clip"
				markdownFilePath="/vault/Body/note.md"
				projectRoot="/vault"
				onOpenFile={onOpenFile}
				theme={mockTheme}
			/>
		);

		const chip = await screen.findByRole('button', { name: /Demo clip/ });
		await waitFor(() => expect(chip.hasAttribute('disabled')).toBe(false));
		fireEvent.click(chip);
		expect(onOpenFile).toHaveBeenCalledWith('/vault/clip.mp4');
		expect(readFile).not.toHaveBeenCalled();
	});

	it('marks a media embed that resolves nowhere as not found', async () => {
		stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
		render(<MarkdownImage src="gone.mp3" markdownFilePath="/vault/note.md" theme={mockTheme} />);
		expect(await screen.findByText('Not found: gone.mp3')).toBeTruthy();
	});
});
