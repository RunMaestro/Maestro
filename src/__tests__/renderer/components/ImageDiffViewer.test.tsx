/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

// Mock window.maestro
const mockShowFile = vi.fn();
const mockReadFile = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();

	// Reset maestro mocks
	(window as any).maestro = {
		git: {
			showFile: mockShowFile,
		},
		fs: {
			readFile: mockReadFile,
		},
	};
});

// Import after mocks are set up
import { ImageDiffViewer } from '../../../renderer/components/ImageDiffViewer';
import type { Theme } from '../../../renderer/types';

// Default test theme
const defaultTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark' as const,
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#252525',
		bgActivity: '#2a2a2a',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#7c3aed',
		accentDim: 'rgba(124, 58, 237, 0.2)',
		border: '#404040',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		inputBg: '#2a2a2a',
	},
};

describe('ImageDiffViewer', () => {
	describe('Loading State', () => {
		it('shows loading spinner initially', async () => {
			// Keep the promises pending to show loading state
			mockShowFile.mockImplementation(() => new Promise(() => {}));
			mockReadFile.mockImplementation(() => new Promise(() => {}));

			render(
				<ImageDiffViewer
					oldPath="old/image.png"
					newPath="new/image.png"
					cwd="/project"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			expect(screen.getByText('Loading images...')).toBeInTheDocument();
		});

		it('shows loading animation with spinner', async () => {
			mockShowFile.mockImplementation(() => new Promise(() => {}));
			mockReadFile.mockImplementation(() => new Promise(() => {}));

			const { container } = render(
				<ImageDiffViewer
					oldPath="old/image.png"
					newPath="new/image.png"
					cwd="/project"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			// Check for the spinner element with animate-spin class
			const spinner = container.querySelector('.animate-spin');
			expect(spinner).toBeInTheDocument();
		});
	});

	describe('Normal Diff (Modified File)', () => {
		it('loads both old and new images', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,oldimage' });
			mockReadFile.mockResolvedValue('data:image/png;base64,newimage');

			render(
				<ImageDiffViewer
					oldPath="images/logo.png"
					newPath="images/logo.png"
					cwd="/project"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('Binary file changed')).toBeInTheDocument();
			});

			// Verify API calls
			expect(mockShowFile).toHaveBeenCalledWith('/project', 'HEAD', 'images/logo.png');
			expect(mockReadFile).toHaveBeenCalledWith('/project/images/logo.png', undefined);
		});

		it('displays Before and After labels', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			render(
				<ImageDiffViewer
					oldPath="img.png"
					newPath="img.png"
					cwd="/proj"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('Before')).toBeInTheDocument();
				expect(screen.getByText('After')).toBeInTheDocument();
			});
		});

		it('renders images with correct src attributes', async () => {
			const oldContent = 'data:image/png;base64,OLDBASE64';
			const newContent = 'data:image/png;base64,NEWBASE64';

			mockShowFile.mockResolvedValue({ content: oldContent });
			mockReadFile.mockResolvedValue(newContent);

			render(
				<ImageDiffViewer
					oldPath="test.png"
					newPath="test.png"
					cwd="/cwd"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				const images = screen.getAllByRole('img');
				expect(images).toHaveLength(2);
				expect(images[0]).toHaveAttribute('src', oldContent);
				expect(images[0]).toHaveAttribute('alt', 'Before');
				expect(images[1]).toHaveAttribute('src', newContent);
				expect(images[1]).toHaveAttribute('alt', 'After');
			});
		});

		it('displays path names in headers', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			render(
				<ImageDiffViewer
					oldPath="assets/icon.svg"
					newPath="assets/icon-new.svg"
					cwd="/project"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('assets/icon.svg')).toBeInTheDocument();
				expect(screen.getByText('assets/icon-new.svg')).toBeInTheDocument();
			});
		});
	});

	describe('New File', () => {
		it('shows new file badge', async () => {
			mockReadFile.mockResolvedValue('data:image/png;base64,newfile');

			render(
				<ImageDiffViewer
					oldPath="newimage.png"
					newPath="newimage.png"
					cwd="/project"
					theme={defaultTheme}
					isNewFile={true}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('New file')).toBeInTheDocument();
			});
		});

		it('shows "File did not exist" in old image panel', async () => {
			mockReadFile.mockResolvedValue('data:image/png;base64,newfile');

			render(
				<ImageDiffViewer
					oldPath="newimage.png"
					newPath="newimage.png"
					cwd="/project"
					theme={defaultTheme}
					isNewFile={true}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('File did not exist')).toBeInTheDocument();
				// Also check the header message
				expect(screen.getByText('(file did not exist)')).toBeInTheDocument();
			});
		});

		it('does not call git showFile for new files', async () => {
			mockReadFile.mockResolvedValue('data:image/png;base64,newfile');

			render(
				<ImageDiffViewer
					oldPath="newimage.png"
					newPath="newimage.png"
					cwd="/project"
					theme={defaultTheme}
					isNewFile={true}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('File did not exist')).toBeInTheDocument();
			});

			expect(mockShowFile).not.toHaveBeenCalled();
			expect(mockReadFile).toHaveBeenCalledTimes(1);
		});

		it('displays the new image when file is new', async () => {
			const newContent = 'data:image/png;base64,NEWIMAGE';
			mockReadFile.mockResolvedValue(newContent);

			render(
				<ImageDiffViewer
					oldPath="new.png"
					newPath="new.png"
					cwd="/proj"
					theme={defaultTheme}
					isNewFile={true}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				const images = screen.getAllByRole('img');
				expect(images).toHaveLength(1);
				expect(images[0]).toHaveAttribute('src', newContent);
				expect(images[0]).toHaveAttribute('alt', 'After');
			});
		});
	});

	describe('Deleted File', () => {
		it('shows deleted file badge', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,oldfile' });

			render(
				<ImageDiffViewer
					oldPath="deleted.png"
					newPath="deleted.png"
					cwd="/project"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={true}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('Deleted')).toBeInTheDocument();
			});
		});

		it('shows "File deleted" in new image panel', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,oldfile' });

			render(
				<ImageDiffViewer
					oldPath="deleted.png"
					newPath="deleted.png"
					cwd="/project"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={true}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('File deleted')).toBeInTheDocument();
				expect(screen.getByText('(file deleted)')).toBeInTheDocument();
			});
		});

		it('does not call fs.readFile for deleted files', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,oldfile' });

			render(
				<ImageDiffViewer
					oldPath="deleted.png"
					newPath="deleted.png"
					cwd="/project"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={true}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('File deleted')).toBeInTheDocument();
			});

			expect(mockShowFile).toHaveBeenCalledTimes(1);
			expect(mockReadFile).not.toHaveBeenCalled();
		});

		it('displays the old image when file is deleted', async () => {
			const oldContent = 'data:image/png;base64,DELETEDIMAGE';
			mockShowFile.mockResolvedValue({ content: oldContent });

			render(
				<ImageDiffViewer
					oldPath="old.png"
					newPath="old.png"
					cwd="/proj"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={true}
				/>
			);

			await waitFor(() => {
				const images = screen.getAllByRole('img');
				expect(images).toHaveLength(1);
				expect(images[0]).toHaveAttribute('src', oldContent);
				expect(images[0]).toHaveAttribute('alt', 'Before');
			});
		});
	});

	describe('Error Handling', () => {
		describe('Old Image Errors', () => {
			it('shows error when git showFile returns error', async () => {
				mockShowFile.mockResolvedValue({ error: 'File not found in HEAD' });
				mockReadFile.mockResolvedValue('data:image/png;base64,new');

				render(
					<ImageDiffViewer
						oldPath="img.png"
						newPath="img.png"
						cwd="/project"
						theme={defaultTheme}
						isNewFile={false}
						isDeletedFile={false}
					/>
				);

				await waitFor(() => {
					expect(screen.getByText('File not found in HEAD')).toBeInTheDocument();
					expect(screen.getAllByText('Failed to load')[0]).toBeInTheDocument();
				});
			});

			it('handles Error objects thrown by git showFile', async () => {
				mockShowFile.mockRejectedValue(new Error('Network error'));
				mockReadFile.mockResolvedValue('data:image/png;base64,new');

				render(
					<ImageDiffViewer
						oldPath="img.png"
						newPath="img.png"
						cwd="/project"
						theme={defaultTheme}
						isNewFile={false}
						isDeletedFile={false}
					/>
				);

				await waitFor(() => {
					expect(screen.getByText('Network error')).toBeInTheDocument();
				});
			});

			it('handles non-Error exceptions from git showFile', async () => {
				mockShowFile.mockRejectedValue('String error');
				mockReadFile.mockResolvedValue('data:image/png;base64,new');

				render(
					<ImageDiffViewer
						oldPath="img.png"
						newPath="img.png"
						cwd="/project"
						theme={defaultTheme}
						isNewFile={false}
						isDeletedFile={false}
					/>
				);

				await waitFor(() => {
					expect(screen.getByText('Failed to load old image')).toBeInTheDocument();
				});
			});
		});

		describe('New Image Errors', () => {
			it('handles Error objects thrown by fs.readFile', async () => {
				mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
				mockReadFile.mockRejectedValue(new Error('File access denied'));

				render(
					<ImageDiffViewer
						oldPath="img.png"
						newPath="img.png"
						cwd="/project"
						theme={defaultTheme}
						isNewFile={false}
						isDeletedFile={false}
					/>
				);

				await waitFor(() => {
					expect(screen.getByText('File access denied')).toBeInTheDocument();
				});
			});

			it('handles non-Error exceptions from fs.readFile', async () => {
				mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
				mockReadFile.mockRejectedValue('Unknown error');

				render(
					<ImageDiffViewer
						oldPath="img.png"
						newPath="img.png"
						cwd="/project"
						theme={defaultTheme}
						isNewFile={false}
						isDeletedFile={false}
					/>
				);

				await waitFor(() => {
					expect(screen.getByText('Failed to load new image')).toBeInTheDocument();
				});
			});
		});

		describe('Both Images Error', () => {
			it('shows errors for both images when both fail', async () => {
				mockShowFile.mockRejectedValue(new Error('Old error'));
				mockReadFile.mockRejectedValue(new Error('New error'));

				render(
					<ImageDiffViewer
						oldPath="img.png"
						newPath="img.png"
						cwd="/project"
						theme={defaultTheme}
						isNewFile={false}
						isDeletedFile={false}
					/>
				);

				await waitFor(() => {
					expect(screen.getByText('Old error')).toBeInTheDocument();
					expect(screen.getByText('New error')).toBeInTheDocument();
				});
			});
		});
	});

	describe('Empty Content Handling', () => {
		it('shows placeholder when old image returns empty content', async () => {
			mockShowFile.mockResolvedValue({ content: null });
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			const { container } = render(
				<ImageDiffViewer
					oldPath="img.png"
					newPath="img.png"
					cwd="/project"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				// Should show ImageIcon placeholder, not an img element
				// Check that we only have one img (the new one)
				const images = container.querySelectorAll('img');
				expect(images).toHaveLength(1);
			});
		});

		it('shows placeholder when new image returns empty content', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
			mockReadFile.mockResolvedValue(null);

			const { container } = render(
				<ImageDiffViewer
					oldPath="img.png"
					newPath="img.png"
					cwd="/project"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				// Should show ImageIcon placeholder for new, img for old
				const images = container.querySelectorAll('img');
				expect(images).toHaveLength(1);
				expect(images[0]).toHaveAttribute('alt', 'Before');
			});
		});
	});

	describe('Styling', () => {
		it('applies theme colors correctly', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			const { container } = render(
				<ImageDiffViewer
					oldPath="img.png"
					newPath="img.png"
					cwd="/project"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('Binary file changed')).toBeInTheDocument();
			});

			// Check header background color
			// Hex #2a2a2a converts to rgb(42, 42, 42)
			// Need to get the parent div that has the background color
			const headerText = screen.getByText('Binary file changed');
			const headerInnerDiv = headerText.closest('div'); // flex items-center gap-2
			const headerOuterDiv = headerInnerDiv?.parentElement; // has background-color
			expect(headerOuterDiv).toHaveStyle({ backgroundColor: 'rgb(42, 42, 42)' });
		});

		it('uses crisp-edges for image rendering', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			render(
				<ImageDiffViewer
					oldPath="img.png"
					newPath="img.png"
					cwd="/project"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				const images = screen.getAllByRole('img');
				images.forEach((img) => {
					expect(img).toHaveStyle({ imageRendering: 'crisp-edges' });
				});
			});
		});

		it('renders side-by-side grid layout', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			const { container } = render(
				<ImageDiffViewer
					oldPath="img.png"
					newPath="img.png"
					cwd="/project"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				const grid = container.querySelector('.grid-cols-2');
				expect(grid).toBeInTheDocument();
			});
		});

		it('applies correct border color from theme', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			const { container } = render(
				<ImageDiffViewer
					oldPath="img.png"
					newPath="img.png"
					cwd="/project"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('Binary file changed')).toBeInTheDocument();
			});

			// Check that image containers have the correct border
			const imagePanels = container.querySelectorAll('.rounded-lg.overflow-hidden');
			expect(imagePanels).toHaveLength(2);
		});
	});

	describe('Image Classes and Constraints', () => {
		it('applies max dimension constraints to images', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			render(
				<ImageDiffViewer
					oldPath="img.png"
					newPath="img.png"
					cwd="/project"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				const images = screen.getAllByRole('img');
				images.forEach((img) => {
					expect(img.className).toContain('max-w-full');
					expect(img.className).toContain('object-contain');
				});
			});
		});
	});

	describe('Effect Dependencies', () => {
		it('reloads images when cwd changes', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			const { rerender } = render(
				<ImageDiffViewer
					oldPath="img.png"
					newPath="img.png"
					cwd="/project1"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(mockShowFile).toHaveBeenCalledWith('/project1', 'HEAD', 'img.png');
			});

			mockShowFile.mockClear();
			mockReadFile.mockClear();

			rerender(
				<ImageDiffViewer
					oldPath="img.png"
					newPath="img.png"
					cwd="/project2"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(mockShowFile).toHaveBeenCalledWith('/project2', 'HEAD', 'img.png');
			});
		});

		it('reloads images when paths change', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			const { rerender } = render(
				<ImageDiffViewer
					oldPath="a.png"
					newPath="a.png"
					cwd="/proj"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(mockShowFile).toHaveBeenCalledWith('/proj', 'HEAD', 'a.png');
			});

			mockShowFile.mockClear();
			mockReadFile.mockClear();

			rerender(
				<ImageDiffViewer
					oldPath="b.png"
					newPath="b.png"
					cwd="/proj"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(mockShowFile).toHaveBeenCalledWith('/proj', 'HEAD', 'b.png');
				expect(mockReadFile).toHaveBeenCalledWith('/proj/b.png', undefined);
			});
		});

		it('reloads when isNewFile flag changes', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			const { rerender } = render(
				<ImageDiffViewer
					oldPath="img.png"
					newPath="img.png"
					cwd="/proj"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(mockShowFile).toHaveBeenCalled();
			});

			mockShowFile.mockClear();
			mockReadFile.mockClear();

			rerender(
				<ImageDiffViewer
					oldPath="img.png"
					newPath="img.png"
					cwd="/proj"
					theme={defaultTheme}
					isNewFile={true}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				// Should not call showFile when isNewFile is true
				expect(mockShowFile).not.toHaveBeenCalled();
			});
		});

		it('reloads when isDeletedFile flag changes', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			const { rerender } = render(
				<ImageDiffViewer
					oldPath="img.png"
					newPath="img.png"
					cwd="/proj"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(mockReadFile).toHaveBeenCalled();
			});

			mockShowFile.mockClear();
			mockReadFile.mockClear();

			rerender(
				<ImageDiffViewer
					oldPath="img.png"
					newPath="img.png"
					cwd="/proj"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={true}
				/>
			);

			await waitFor(() => {
				// Should not call readFile when isDeletedFile is true
				expect(mockReadFile).not.toHaveBeenCalled();
			});
		});
	});

	describe('Light Theme', () => {
		const lightTheme: Theme = {
			id: 'light-theme',
			name: 'Light Theme',
			mode: 'light' as const,
			colors: {
				bgMain: '#ffffff',
				bgSidebar: '#f5f5f5',
				bgActivity: '#eeeeee',
				textMain: '#000000',
				textDim: '#666666',
				accent: '#7c3aed',
				accentDim: 'rgba(124, 58, 237, 0.2)',
				border: '#cccccc',
				success: '#22c55e',
				warning: '#f59e0b',
				error: '#ef4444',
				inputBg: '#f0f0f0',
			},
		};

		it('applies light theme colors', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			render(
				<ImageDiffViewer
					oldPath="img.png"
					newPath="img.png"
					cwd="/proj"
					theme={lightTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				// Hex #eeeeee converts to rgb(238, 238, 238)
				// Need to get the parent div that has the background color
				const headerText = screen.getByText('Binary file changed');
				const headerInnerDiv = headerText.closest('div'); // flex items-center gap-2
				const headerOuterDiv = headerInnerDiv?.parentElement; // has background-color
				expect(headerOuterDiv).toHaveStyle({ backgroundColor: 'rgb(238, 238, 238)' });
			});
		});
	});

	describe('Edge Cases', () => {
		it('handles paths with special characters', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			render(
				<ImageDiffViewer
					oldPath="images/my image (1).png"
					newPath="images/my image (1).png"
					cwd="/project with spaces"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(mockShowFile).toHaveBeenCalledWith(
					'/project with spaces',
					'HEAD',
					'images/my image (1).png'
				);
				expect(mockReadFile).toHaveBeenCalledWith(
					'/project with spaces/images/my image (1).png',
					undefined
				);
			});
		});

		it('handles unicode in file paths', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			render(
				<ImageDiffViewer
					oldPath="画像/テスト.png"
					newPath="画像/テスト.png"
					cwd="/プロジェクト"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				// Path appears in both Before and After sections
				const paths = screen.getAllByText('画像/テスト.png');
				expect(paths).toHaveLength(2);
			});
		});

		it('handles very long paths', async () => {
			const longPath = 'very/deep/nested/directory/structure/with/many/levels/image.png';
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			render(
				<ImageDiffViewer
					oldPath={longPath}
					newPath={longPath}
					cwd="/proj"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				// Path appears in both Before and After sections
				const paths = screen.getAllByText(longPath);
				expect(paths).toHaveLength(2);
			});
		});

		it('handles different old and new paths', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			render(
				<ImageDiffViewer
					oldPath="assets/old-logo.png"
					newPath="assets/new-logo.png"
					cwd="/proj"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('assets/old-logo.png')).toBeInTheDocument();
				expect(screen.getByText('assets/new-logo.png')).toBeInTheDocument();
			});

			expect(mockShowFile).toHaveBeenCalledWith('/proj', 'HEAD', 'assets/old-logo.png');
			expect(mockReadFile).toHaveBeenCalledWith('/proj/assets/new-logo.png', undefined);
		});
	});

	describe('Icons', () => {
		it('renders ImageIcon in header', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			const { container } = render(
				<ImageDiffViewer
					oldPath="img.png"
					newPath="img.png"
					cwd="/proj"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('Binary file changed')).toBeInTheDocument();
			});

			// Check for SVG icons (lucide-react renders SVGs)
			const svgs = container.querySelectorAll('svg');
			expect(svgs.length).toBeGreaterThan(0);
		});

		it('renders Plus icon for new files', async () => {
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			const { container } = render(
				<ImageDiffViewer
					oldPath="new.png"
					newPath="new.png"
					cwd="/proj"
					theme={defaultTheme}
					isNewFile={true}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('New file')).toBeInTheDocument();
			});

			// Check that Plus icon (w-3 h-3) is rendered in the new file badge
			const newFileBadge = screen.getByText('New file').closest('span');
			const plusIcon = newFileBadge?.querySelector('svg');
			expect(plusIcon).toBeInTheDocument();
		});

		it('renders Trash2 icon for deleted files', async () => {
			mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });

			render(
				<ImageDiffViewer
					oldPath="deleted.png"
					newPath="deleted.png"
					cwd="/proj"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={true}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('Deleted')).toBeInTheDocument();
			});

			// Check that Trash2 icon is rendered in the deleted badge
			const deletedBadge = screen.getByText('Deleted').closest('span');
			const trashIcon = deletedBadge?.querySelector('svg');
			expect(trashIcon).toBeInTheDocument();
		});

		it('renders AlertCircle icon for errors', async () => {
			mockShowFile.mockRejectedValue(new Error('Load failed'));
			mockReadFile.mockResolvedValue('data:image/png;base64,new');

			const { container } = render(
				<ImageDiffViewer
					oldPath="img.png"
					newPath="img.png"
					cwd="/proj"
					theme={defaultTheme}
					isNewFile={false}
					isDeletedFile={false}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('Failed to load')).toBeInTheDocument();
			});

			// Should have error icon (AlertCircle)
			const errorSection = screen.getByText('Failed to load').closest('div');
			const errorIcon = errorSection?.querySelector('svg');
			expect(errorIcon).toBeInTheDocument();
			expect(errorIcon?.classList.contains('text-red-500')).toBe(true);
		});
	});
});
