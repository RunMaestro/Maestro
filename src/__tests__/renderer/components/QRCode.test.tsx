/**
 * Tests for QRCode component
 *
 * Tests QR code generation, loading states, error handling,
 * and prop handling for the QRCode display component.
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QRCode } from '../../../renderer/components/QRCode';

// Mock the qrcode library
vi.mock('qrcode', () => ({
	default: {
		toDataURL: vi.fn(),
	},
}));

// Import the mocked module
import QRCodeLib from 'qrcode';

describe('QRCode', () => {
	const mockDataUrl = 'data:image/png;base64,mockQRCodeImageData';
	const mockToDataURL = vi.mocked(QRCodeLib.toDataURL);

	beforeEach(() => {
		vi.clearAllMocks();
		// Default to successful generation
		mockToDataURL.mockResolvedValue(mockDataUrl);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('Initial Render', () => {
		it('should show loading state while generating QR code', async () => {
			// Make the promise pending
			let resolvePromise: (value: string) => void;
			mockToDataURL.mockReturnValue(
				new Promise((resolve) => {
					resolvePromise = resolve;
				})
			);

			render(<QRCode value="https://example.com" />);

			// Should show loading placeholder
			const loadingDiv = document.querySelector('.animate-pulse');
			expect(loadingDiv).toBeInTheDocument();

			// Resolve and verify loading state goes away
			await act(async () => {
				resolvePromise!(mockDataUrl);
			});

			await waitFor(() => {
				expect(document.querySelector('.animate-pulse')).not.toBeInTheDocument();
			});
		});

		it('should render QR code image after successful generation', async () => {
			render(<QRCode value="https://example.com" />);

			await waitFor(() => {
				const img = screen.getByRole('img');
				expect(img).toBeInTheDocument();
				expect(img).toHaveAttribute('src', mockDataUrl);
			});
		});

		it('should not generate QR code when value is empty', async () => {
			render(<QRCode value="" />);

			// Should show loading placeholder but not call library
			expect(mockToDataURL).not.toHaveBeenCalled();

			const loadingDiv = document.querySelector('.animate-pulse');
			expect(loadingDiv).toBeInTheDocument();
		});
	});

	describe('Default Props', () => {
		it('should use default size of 128', async () => {
			render(<QRCode value="https://example.com" />);

			await waitFor(() => {
				const img = screen.getByRole('img');
				expect(img).toHaveAttribute('width', '128');
				expect(img).toHaveAttribute('height', '128');
			});

			expect(mockToDataURL).toHaveBeenCalledWith(
				'https://example.com',
				expect.objectContaining({
					width: 128,
				})
			);
		});

		it('should use default alt text "QR Code"', async () => {
			render(<QRCode value="https://example.com" />);

			await waitFor(() => {
				const img = screen.getByRole('img');
				expect(img).toHaveAttribute('alt', 'QR Code');
			});
		});

		it('should use transparent background by default', async () => {
			render(<QRCode value="https://example.com" />);

			await waitFor(() => {
				expect(mockToDataURL).toHaveBeenCalledWith(
					'https://example.com',
					expect.objectContaining({
						color: {
							dark: '#FFFFFF',
							light: 'transparent',
						},
					})
				);
			});
		});

		it('should use white foreground color by default', async () => {
			render(<QRCode value="https://example.com" />);

			await waitFor(() => {
				expect(mockToDataURL).toHaveBeenCalledWith(
					'https://example.com',
					expect.objectContaining({
						color: {
							dark: '#FFFFFF',
							light: 'transparent',
						},
					})
				);
			});
		});

		it('should use empty className by default', async () => {
			render(<QRCode value="https://example.com" />);

			await waitFor(() => {
				const img = screen.getByRole('img');
				// Empty className results in class="" attribute
				expect(img).toHaveAttribute('class', '');
			});
		});
	});

	describe('Custom Props', () => {
		it('should use custom size', async () => {
			render(<QRCode value="https://example.com" size={256} />);

			await waitFor(() => {
				const img = screen.getByRole('img');
				expect(img).toHaveAttribute('width', '256');
				expect(img).toHaveAttribute('height', '256');
			});

			expect(mockToDataURL).toHaveBeenCalledWith(
				'https://example.com',
				expect.objectContaining({
					width: 256,
				})
			);
		});

		it('should use custom background color', async () => {
			render(<QRCode value="https://example.com" bgColor="#000000" />);

			await waitFor(() => {
				expect(mockToDataURL).toHaveBeenCalledWith(
					'https://example.com',
					expect.objectContaining({
						color: expect.objectContaining({
							light: '#000000',
						}),
					})
				);
			});
		});

		it('should use custom foreground color', async () => {
			render(<QRCode value="https://example.com" fgColor="#FF0000" />);

			await waitFor(() => {
				expect(mockToDataURL).toHaveBeenCalledWith(
					'https://example.com',
					expect.objectContaining({
						color: expect.objectContaining({
							dark: '#FF0000',
						}),
					})
				);
			});
		});

		it('should use custom alt text', async () => {
			render(<QRCode value="https://example.com" alt="Scan to visit" />);

			await waitFor(() => {
				const img = screen.getByRole('img');
				expect(img).toHaveAttribute('alt', 'Scan to visit');
			});
		});

		it('should use custom className', async () => {
			render(<QRCode value="https://example.com" className="my-custom-class" />);

			await waitFor(() => {
				const img = screen.getByRole('img');
				expect(img).toHaveClass('my-custom-class');
			});
		});

		it('should combine multiple custom props', async () => {
			render(
				<QRCode
					value="https://mysite.com"
					size={200}
					bgColor="#1a1a1a"
					fgColor="#00FF00"
					alt="Custom QR"
					className="rounded shadow"
				/>
			);

			await waitFor(() => {
				const img = screen.getByRole('img');
				expect(img).toHaveAttribute('src', mockDataUrl);
				expect(img).toHaveAttribute('width', '200');
				expect(img).toHaveAttribute('height', '200');
				expect(img).toHaveAttribute('alt', 'Custom QR');
				expect(img).toHaveClass('rounded');
				expect(img).toHaveClass('shadow');
			});

			expect(mockToDataURL).toHaveBeenCalledWith('https://mysite.com', {
				width: 200,
				margin: 1,
				color: {
					dark: '#00FF00',
					light: '#1a1a1a',
				},
				errorCorrectionLevel: 'M',
			});
		});
	});

	describe('Error Handling', () => {
		it('should show error state when generation fails', async () => {
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			mockToDataURL.mockRejectedValue(new Error('Generation failed'));

			render(<QRCode value="https://example.com" />);

			await waitFor(() => {
				expect(screen.getByText('Failed to generate QR code')).toBeInTheDocument();
			});

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				'Failed to generate QR code:',
				expect.any(Error)
			);

			consoleErrorSpy.mockRestore();
		});

		it('should apply error styling', async () => {
			mockToDataURL.mockRejectedValue(new Error('Generation failed'));
			vi.spyOn(console, 'error').mockImplementation(() => {});

			render(<QRCode value="https://example.com" size={150} />);

			await waitFor(() => {
				const errorContainer = screen.getByText('Failed to generate QR code').parentElement;
				expect(errorContainer).toHaveStyle({ width: '150px', height: '150px' });
			});
		});

		it('should include custom className in error state', async () => {
			mockToDataURL.mockRejectedValue(new Error('Generation failed'));
			vi.spyOn(console, 'error').mockImplementation(() => {});

			render(<QRCode value="https://example.com" className="my-error-class" />);

			await waitFor(() => {
				const errorContainer = screen.getByText('Failed to generate QR code').parentElement;
				expect(errorContainer).toHaveClass('my-error-class');
			});
		});

		it('should clear error when value changes to valid', async () => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			mockToDataURL.mockRejectedValueOnce(new Error('Generation failed'));

			const { rerender } = render(<QRCode value="bad-value" />);

			await waitFor(() => {
				expect(screen.getByText('Failed to generate QR code')).toBeInTheDocument();
			});

			// Reset mock to succeed
			mockToDataURL.mockResolvedValue(mockDataUrl);

			rerender(<QRCode value="https://example.com" />);

			await waitFor(() => {
				const img = screen.getByRole('img');
				expect(img).toBeInTheDocument();
				expect(screen.queryByText('Failed to generate QR code')).not.toBeInTheDocument();
			});
		});
	});

	describe('Prop Changes', () => {
		it('should regenerate QR code when value changes', async () => {
			const { rerender } = render(<QRCode value="https://example.com" />);

			await waitFor(() => {
				expect(screen.getByRole('img')).toBeInTheDocument();
			});

			expect(mockToDataURL).toHaveBeenCalledTimes(1);
			expect(mockToDataURL).toHaveBeenCalledWith('https://example.com', expect.any(Object));

			rerender(<QRCode value="https://different.com" />);

			await waitFor(() => {
				expect(mockToDataURL).toHaveBeenCalledTimes(2);
				expect(mockToDataURL).toHaveBeenLastCalledWith('https://different.com', expect.any(Object));
			});
		});

		it('should regenerate QR code when size changes', async () => {
			const { rerender } = render(<QRCode value="https://example.com" size={128} />);

			await waitFor(() => {
				expect(screen.getByRole('img')).toBeInTheDocument();
			});

			rerender(<QRCode value="https://example.com" size={256} />);

			await waitFor(() => {
				expect(mockToDataURL).toHaveBeenCalledTimes(2);
				expect(mockToDataURL).toHaveBeenLastCalledWith(
					'https://example.com',
					expect.objectContaining({ width: 256 })
				);
			});
		});

		it('should regenerate QR code when bgColor changes', async () => {
			const { rerender } = render(<QRCode value="https://example.com" bgColor="#000000" />);

			await waitFor(() => {
				expect(screen.getByRole('img')).toBeInTheDocument();
			});

			rerender(<QRCode value="https://example.com" bgColor="#FFFFFF" />);

			await waitFor(() => {
				expect(mockToDataURL).toHaveBeenCalledTimes(2);
				expect(mockToDataURL).toHaveBeenLastCalledWith(
					'https://example.com',
					expect.objectContaining({
						color: expect.objectContaining({ light: '#FFFFFF' }),
					})
				);
			});
		});

		it('should regenerate QR code when fgColor changes', async () => {
			const { rerender } = render(<QRCode value="https://example.com" fgColor="#FFFFFF" />);

			await waitFor(() => {
				expect(screen.getByRole('img')).toBeInTheDocument();
			});

			rerender(<QRCode value="https://example.com" fgColor="#000000" />);

			await waitFor(() => {
				expect(mockToDataURL).toHaveBeenCalledTimes(2);
				expect(mockToDataURL).toHaveBeenLastCalledWith(
					'https://example.com',
					expect.objectContaining({
						color: expect.objectContaining({ dark: '#000000' }),
					})
				);
			});
		});

		it('should show loading when value changes from empty', async () => {
			const { rerender } = render(<QRCode value="" />);

			// Should show loading with no call to library
			expect(mockToDataURL).not.toHaveBeenCalled();

			rerender(<QRCode value="https://example.com" />);

			await waitFor(() => {
				expect(mockToDataURL).toHaveBeenCalledTimes(1);
				expect(screen.getByRole('img')).toBeInTheDocument();
			});
		});

		it('should clear dataUrl when value becomes empty', async () => {
			const { rerender } = render(<QRCode value="https://example.com" />);

			await waitFor(() => {
				expect(screen.getByRole('img')).toBeInTheDocument();
			});

			rerender(<QRCode value="" />);

			await waitFor(() => {
				expect(screen.queryByRole('img')).not.toBeInTheDocument();
				const loadingDiv = document.querySelector('.animate-pulse');
				expect(loadingDiv).toBeInTheDocument();
			});
		});
	});

	describe('Image Styling', () => {
		it('should apply pixelated image rendering', async () => {
			render(<QRCode value="https://example.com" />);

			await waitFor(() => {
				const img = screen.getByRole('img');
				expect(img).toHaveStyle({ imageRendering: 'pixelated' });
			});
		});

		it('should set correct width and height attributes', async () => {
			render(<QRCode value="https://example.com" size={180} />);

			await waitFor(() => {
				const img = screen.getByRole('img');
				expect(img).toHaveAttribute('width', '180');
				expect(img).toHaveAttribute('height', '180');
			});
		});
	});

	describe('Loading State Styling', () => {
		it('should show loading placeholder with correct size', async () => {
			let resolvePromise: (value: string) => void;
			mockToDataURL.mockReturnValue(
				new Promise((resolve) => {
					resolvePromise = resolve;
				})
			);

			render(<QRCode value="https://example.com" size={200} />);

			const container = document.querySelector('.flex.items-center.justify-center');
			expect(container).toHaveStyle({ width: '200px', height: '200px' });

			const loadingDiv = document.querySelector('.animate-pulse');
			expect(loadingDiv).toHaveStyle({
				width: '200px',
				height: '200px',
				backgroundColor: 'rgba(255,255,255,0.1)',
			});

			// Cleanup
			await act(async () => {
				resolvePromise!(mockDataUrl);
			});
		});

		it('should include custom className in loading state', async () => {
			let resolvePromise: (value: string) => void;
			mockToDataURL.mockReturnValue(
				new Promise((resolve) => {
					resolvePromise = resolve;
				})
			);

			render(<QRCode value="https://example.com" className="my-loading-class" />);

			const container = document.querySelector('.flex.items-center.justify-center');
			expect(container).toHaveClass('my-loading-class');

			// Cleanup
			await act(async () => {
				resolvePromise!(mockDataUrl);
			});
		});
	});

	describe('QRCodeLib Configuration', () => {
		it('should set margin to 1', async () => {
			render(<QRCode value="https://example.com" />);

			await waitFor(() => {
				expect(mockToDataURL).toHaveBeenCalledWith(
					'https://example.com',
					expect.objectContaining({
						margin: 1,
					})
				);
			});
		});

		it('should set error correction level to M', async () => {
			render(<QRCode value="https://example.com" />);

			await waitFor(() => {
				expect(mockToDataURL).toHaveBeenCalledWith(
					'https://example.com',
					expect.objectContaining({
						errorCorrectionLevel: 'M',
					})
				);
			});
		});
	});

	describe('Various Value Types', () => {
		it('should handle URL values', async () => {
			render(<QRCode value="https://example.com/path?query=1" />);

			await waitFor(() => {
				expect(mockToDataURL).toHaveBeenCalledWith(
					'https://example.com/path?query=1',
					expect.any(Object)
				);
			});
		});

		it('should handle plain text values', async () => {
			render(<QRCode value="Hello World" />);

			await waitFor(() => {
				expect(mockToDataURL).toHaveBeenCalledWith('Hello World', expect.any(Object));
			});
		});

		it('should handle special characters', async () => {
			render(<QRCode value="Test with émoji 🎉 and üñíçödé" />);

			await waitFor(() => {
				expect(mockToDataURL).toHaveBeenCalledWith(
					'Test with émoji 🎉 and üñíçödé',
					expect.any(Object)
				);
			});
		});

		it('should handle very long values', async () => {
			const longValue = 'x'.repeat(1000);
			render(<QRCode value={longValue} />);

			await waitFor(() => {
				expect(mockToDataURL).toHaveBeenCalledWith(longValue, expect.any(Object));
			});
		});
	});
});
