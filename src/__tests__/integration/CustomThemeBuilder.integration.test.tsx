/**
 * Tests for CustomThemeBuilder component
 *
 * CustomThemeBuilder allows users to create, edit, import, and export custom themes.
 * Tests cover color validation, import/export functionality, and user notifications.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { CustomThemeBuilder } from '../../renderer/components/CustomThemeBuilder';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { THEMES } from '../../renderer/constants/themes';
import type { Theme, ThemeColors, ThemeId } from '../../shared/theme-types';

function render(ui: React.ReactElement) {
	return rtlRender(<LayerStackProvider>{ui}</LayerStackProvider>);
}

// ============================================================================
// Test Fixtures
// ============================================================================

const mockThemeColors: ThemeColors = {
	bgMain: '#1a1a2e',
	bgSidebar: '#16213e',
	bgActivity: '#0f3460',
	border: '#555555',
	textMain: '#e0e0e0',
	textDim: '#888888',
	accent: '#8b5cf6',
	accentDim: '#8b5cf640',
	accentText: '#a78bfa',
	accentForeground: '#ffffff',
	success: '#10b981',
	warning: '#f59e0b',
	error: '#ef4444',
};

const mockTheme: Theme = {
	id: 'dracula' as ThemeId,
	name: 'Dracula',
	mode: 'dark',
	colors: mockThemeColors,
};

/**
 * Create a valid theme export JSON string
 */
function createValidThemeJSON(colors: ThemeColors = mockThemeColors): string {
	return JSON.stringify({
		name: 'Custom Theme',
		baseTheme: 'dracula',
		colors,
		exportedAt: new Date().toISOString(),
	});
}

/**
 * Create a File object for testing file input
 */
function createFileFromJSON(content: string, filename = 'theme.json'): File {
	return new File([content], filename, { type: 'application/json' });
}

/**
 * Simulate file selection on an input element
 */
async function simulateFileUpload(input: HTMLInputElement, file: File): Promise<void> {
	Object.defineProperty(input, 'files', {
		value: [file],
		writable: false,
	});
	fireEvent.change(input);
	// Wait for FileReader to complete
	await waitFor(() => {}, { timeout: 100 });
}

// ============================================================================
// Tests
// ============================================================================

describe('CustomThemeBuilder', () => {
	let setCustomThemeColors: ReturnType<typeof vi.fn>;
	let setCustomThemeBaseId: ReturnType<typeof vi.fn>;
	let onSelect: ReturnType<typeof vi.fn>;
	let onImportError: ReturnType<typeof vi.fn>;
	let onImportSuccess: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		setCustomThemeColors = vi.fn();
		setCustomThemeBaseId = vi.fn();
		onSelect = vi.fn();
		onImportError = vi.fn();
		onImportSuccess = vi.fn();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('Rendering', () => {
		it('should render without crashing', () => {
			render(
				<CustomThemeBuilder
					theme={mockTheme}
					customThemeColors={mockThemeColors}
					setCustomThemeColors={setCustomThemeColors}
					customThemeBaseId="dracula"
					setCustomThemeBaseId={setCustomThemeBaseId}
					isSelected={false}
					onSelect={onSelect}
				/>
			);

			expect(screen.getByText('Custom Theme')).toBeInTheDocument();
		});

		it('should render the mini UI preview', () => {
			render(
				<CustomThemeBuilder
					theme={mockTheme}
					customThemeColors={mockThemeColors}
					setCustomThemeColors={setCustomThemeColors}
					customThemeBaseId="dracula"
					setCustomThemeBaseId={setCustomThemeBaseId}
					isSelected={false}
					onSelect={onSelect}
				/>
			);

			expect(screen.getByText('Preview')).toBeInTheDocument();
			expect(screen.getByText('AI Terminal')).toBeInTheDocument();
		});

		it('should render color editor section', () => {
			render(
				<CustomThemeBuilder
					theme={mockTheme}
					customThemeColors={mockThemeColors}
					setCustomThemeColors={setCustomThemeColors}
					customThemeBaseId="dracula"
					setCustomThemeBaseId={setCustomThemeBaseId}
					isSelected={false}
					onSelect={onSelect}
				/>
			);

			expect(screen.getByText('Colors')).toBeInTheDocument();
			expect(screen.getByText('Main Background')).toBeInTheDocument();
			expect(screen.getByText('Sidebar Background')).toBeInTheDocument();
		});

		it('should show check icon when selected', () => {
			render(
				<CustomThemeBuilder
					theme={mockTheme}
					customThemeColors={mockThemeColors}
					setCustomThemeColors={setCustomThemeColors}
					customThemeBaseId="dracula"
					setCustomThemeBaseId={setCustomThemeBaseId}
					isSelected={true}
					onSelect={onSelect}
				/>
			);

			// Check icon should be visible when selected
			const checkIcon = document.querySelector('.w-4.h-4');
			expect(checkIcon).toBeInTheDocument();
		});
	});

	describe('Theme Selection', () => {
		it('should call onSelect when clicked', () => {
			render(
				<CustomThemeBuilder
					theme={mockTheme}
					customThemeColors={mockThemeColors}
					setCustomThemeColors={setCustomThemeColors}
					customThemeBaseId="dracula"
					setCustomThemeBaseId={setCustomThemeBaseId}
					isSelected={false}
					onSelect={onSelect}
				/>
			);

			// Find the main selection button
			const selectButton = screen.getByRole('button', { name: /Custom/i });
			fireEvent.click(selectButton);

			expect(onSelect).toHaveBeenCalledTimes(1);
		});
	});

	describe('Export Functionality', () => {
		it('should export theme when export button is clicked', () => {
			// Mock URL.createObjectURL and revokeObjectURL
			const mockCreateObjectURL = vi.fn(() => 'blob:test-url');
			const mockRevokeObjectURL = vi.fn();
			global.URL.createObjectURL = mockCreateObjectURL;
			global.URL.revokeObjectURL = mockRevokeObjectURL;

			// Mock anchor click
			const mockClick = vi.fn();
			const originalCreateElement = document.createElement.bind(document);
			vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
				const element = originalCreateElement(tagName);
				if (tagName === 'a') {
					element.click = mockClick;
				}
				return element;
			});

			render(
				<CustomThemeBuilder
					theme={mockTheme}
					customThemeColors={mockThemeColors}
					setCustomThemeColors={setCustomThemeColors}
					customThemeBaseId="dracula"
					setCustomThemeBaseId={setCustomThemeBaseId}
					isSelected={false}
					onSelect={onSelect}
				/>
			);

			// Find and click the export button (Download icon)
			const exportButton = screen.getByTitle('Export theme');
			fireEvent.click(exportButton);

			expect(mockCreateObjectURL).toHaveBeenCalled();
			expect(mockClick).toHaveBeenCalled();
			expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:test-url');

			// Cleanup
			vi.restoreAllMocks();
		});
	});

	describe('Import Functionality', () => {
		describe('Valid Imports', () => {
			it('should import valid theme file successfully', async () => {
				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
						onImportError={onImportError}
						onImportSuccess={onImportSuccess}
					/>
				);

				const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
				expect(fileInput).toBeInTheDocument();

				const validTheme = createFileFromJSON(createValidThemeJSON());
				await simulateFileUpload(fileInput, validTheme);

				await waitFor(() => {
					expect(setCustomThemeColors).toHaveBeenCalledWith(mockThemeColors);
					expect(onImportSuccess).toHaveBeenCalledWith('Theme imported successfully');
				});
			});

			it('should update base theme ID if provided in import', async () => {
				const importData = {
					name: 'Custom Theme',
					baseTheme: 'monokai',
					colors: mockThemeColors,
					exportedAt: new Date().toISOString(),
				};

				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
						onImportError={onImportError}
						onImportSuccess={onImportSuccess}
					/>
				);

				const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
				const file = createFileFromJSON(JSON.stringify(importData));
				await simulateFileUpload(fileInput, file);

				await waitFor(() => {
					expect(setCustomThemeBaseId).toHaveBeenCalledWith('monokai');
				});
			});

			it('should import colors without updating base theme when baseTheme is unknown', async () => {
				const importData = {
					name: 'Custom Theme',
					baseTheme: 'unknown-theme',
					colors: mockThemeColors,
					exportedAt: new Date().toISOString(),
				};

				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
						onImportError={onImportError}
						onImportSuccess={onImportSuccess}
					/>
				);

				const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
				await simulateFileUpload(fileInput, createFileFromJSON(JSON.stringify(importData)));

				await waitFor(() => {
					expect(setCustomThemeColors).toHaveBeenCalledWith(mockThemeColors);
					expect(setCustomThemeBaseId).not.toHaveBeenCalled();
					expect(onImportSuccess).toHaveBeenCalledWith('Theme imported successfully');
				});
			});
		});

		describe('Color Validation', () => {
			it('should reject theme with invalid hex color', async () => {
				const invalidColors = {
					...mockThemeColors,
					bgMain: 'not-a-color', // Invalid color
				};

				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
						onImportError={onImportError}
						onImportSuccess={onImportSuccess}
					/>
				);

				const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
				const file = createFileFromJSON(createValidThemeJSON(invalidColors));
				await simulateFileUpload(fileInput, file);

				await waitFor(() => {
					expect(onImportError).toHaveBeenCalled();
					expect(setCustomThemeColors).not.toHaveBeenCalled();
				});
			});

			it('should reject theme with empty string color', async () => {
				const invalidColors = {
					...mockThemeColors,
					accent: '', // Empty string
				};

				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
						onImportError={onImportError}
						onImportSuccess={onImportSuccess}
					/>
				);

				const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
				const file = createFileFromJSON(createValidThemeJSON(invalidColors));
				await simulateFileUpload(fileInput, file);

				await waitFor(() => {
					expect(onImportError).toHaveBeenCalled();
					expect(setCustomThemeColors).not.toHaveBeenCalled();
				});
			});

			it('should truncate invalid color errors after the first three keys', async () => {
				const invalidColors = {
					...mockThemeColors,
					bgMain: 'not-a-color',
					bgSidebar: 'still-not-a-color',
					bgActivity: 'also-not-a-color',
					border: 'invalid-border',
				};

				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
						onImportError={onImportError}
						onImportSuccess={onImportSuccess}
					/>
				);

				const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
				await simulateFileUpload(
					fileInput,
					createFileFromJSON(createValidThemeJSON(invalidColors))
				);

				await waitFor(() => {
					expect(onImportError).toHaveBeenCalledWith(
						'Invalid theme file: invalid color values for bgMain, bgSidebar, bgActivity...'
					);
					expect(setCustomThemeColors).not.toHaveBeenCalled();
				});
			});

			it('should accept valid CSS color names', async () => {
				const namedColors = {
					...mockThemeColors,
					bgMain: 'darkblue', // Valid CSS color name
					accent: 'rebeccapurple',
				};

				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
						onImportError={onImportError}
						onImportSuccess={onImportSuccess}
					/>
				);

				const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
				const file = createFileFromJSON(createValidThemeJSON(namedColors));
				await simulateFileUpload(fileInput, file);

				await waitFor(() => {
					expect(setCustomThemeColors).toHaveBeenCalledWith(namedColors);
					expect(onImportSuccess).toHaveBeenCalled();
				});
			});

			it('should accept valid rgb() colors', async () => {
				const rgbColors = {
					...mockThemeColors,
					bgMain: 'rgb(26, 26, 46)',
				};

				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
						onImportError={onImportError}
						onImportSuccess={onImportSuccess}
					/>
				);

				const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
				const file = createFileFromJSON(createValidThemeJSON(rgbColors));
				await simulateFileUpload(fileInput, file);

				await waitFor(() => {
					expect(setCustomThemeColors).toHaveBeenCalledWith(rgbColors);
				});
			});

			it('should accept valid rgba() colors', async () => {
				const rgbaColors = {
					...mockThemeColors,
					accentDim: 'rgba(139, 92, 246, 0.25)',
				};

				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
						onImportError={onImportError}
						onImportSuccess={onImportSuccess}
					/>
				);

				const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
				const file = createFileFromJSON(createValidThemeJSON(rgbaColors));
				await simulateFileUpload(fileInput, file);

				await waitFor(() => {
					expect(setCustomThemeColors).toHaveBeenCalledWith(rgbaColors);
				});
			});

			it('should accept valid hsl() colors', async () => {
				const hslColors = {
					...mockThemeColors,
					accent: 'hsl(262, 83%, 58%)',
				};

				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
						onImportError={onImportError}
						onImportSuccess={onImportSuccess}
					/>
				);

				const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
				const file = createFileFromJSON(createValidThemeJSON(hslColors));
				await simulateFileUpload(fileInput, file);

				await waitFor(() => {
					expect(setCustomThemeColors).toHaveBeenCalledWith(hslColors);
				});
			});
		});

		describe('Missing Keys Validation', () => {
			it('should reject theme with missing color keys', async () => {
				const incompleteColors = {
					bgMain: '#1a1a2e',
					bgSidebar: '#16213e',
					// Missing all other required keys
				};

				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
						onImportError={onImportError}
						onImportSuccess={onImportSuccess}
					/>
				);

				const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
				const file = createFileFromJSON(
					JSON.stringify({
						colors: incompleteColors,
					})
				);
				await simulateFileUpload(fileInput, file);

				await waitFor(() => {
					expect(onImportError).toHaveBeenCalled();
					const errorCall = onImportError.mock.calls[0][0];
					expect(errorCall).toContain('missing color keys');
					expect(setCustomThemeColors).not.toHaveBeenCalled();
				});
			});

			it('should show which keys are missing in error message', async () => {
				const incompleteColors = {
					bgMain: '#1a1a2e',
					// Missing all other keys
				};

				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
						onImportError={onImportError}
						onImportSuccess={onImportSuccess}
					/>
				);

				const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
				const file = createFileFromJSON(
					JSON.stringify({
						colors: incompleteColors,
					})
				);
				await simulateFileUpload(fileInput, file);

				await waitFor(() => {
					const errorCall = onImportError.mock.calls[0][0];
					expect(errorCall).toContain('bgSidebar');
				});
			});

			it('should omit the ellipsis when three or fewer color keys are missing', async () => {
				const incompleteColors: Partial<ThemeColors> = { ...mockThemeColors };
				delete incompleteColors.warning;
				delete incompleteColors.error;

				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
						onImportError={onImportError}
						onImportSuccess={onImportSuccess}
					/>
				);

				const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
				await simulateFileUpload(
					fileInput,
					createFileFromJSON(JSON.stringify({ colors: incompleteColors }))
				);

				await waitFor(() => {
					expect(onImportError).toHaveBeenCalledWith(
						'Invalid theme file: missing color keys (warning, error)'
					);
					expect(setCustomThemeColors).not.toHaveBeenCalled();
				});
			});
		});

		describe('JSON Parse Errors', () => {
			it('should handle invalid JSON gracefully', async () => {
				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
						onImportError={onImportError}
						onImportSuccess={onImportSuccess}
					/>
				);

				const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
				const file = createFileFromJSON('{ invalid json }');
				await simulateFileUpload(fileInput, file);

				await waitFor(() => {
					expect(onImportError).toHaveBeenCalledWith(
						'Failed to parse theme file: invalid JSON format'
					);
					expect(setCustomThemeColors).not.toHaveBeenCalled();
				});
			});

			it('should handle missing colors object', async () => {
				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
						onImportError={onImportError}
						onImportSuccess={onImportSuccess}
					/>
				);

				const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
				const file = createFileFromJSON(JSON.stringify({ name: 'Theme without colors' }));
				await simulateFileUpload(fileInput, file);

				await waitFor(() => {
					expect(onImportError).toHaveBeenCalledWith('Invalid theme file: missing colors object');
					expect(setCustomThemeColors).not.toHaveBeenCalled();
				});
			});

			it('should handle colors being null', async () => {
				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
						onImportError={onImportError}
						onImportSuccess={onImportSuccess}
					/>
				);

				const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
				const file = createFileFromJSON(JSON.stringify({ colors: null }));
				await simulateFileUpload(fileInput, file);

				await waitFor(() => {
					expect(onImportError).toHaveBeenCalledWith('Invalid theme file: missing colors object');
				});
			});
		});

		describe('Import Without Callbacks', () => {
			it('should work without error callback (no crash)', async () => {
				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
						// No onImportError or onImportSuccess
					/>
				);

				const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
				const file = createFileFromJSON('{ invalid }');

				// Should not throw
				await simulateFileUpload(fileInput, file);
			});

			it('should still apply valid theme without success callback', async () => {
				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
						// No callbacks
					/>
				);

				const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
				const file = createFileFromJSON(createValidThemeJSON());
				await simulateFileUpload(fileInput, file);

				await waitFor(() => {
					expect(setCustomThemeColors).toHaveBeenCalledWith(mockThemeColors);
				});
			});
		});
	});

	describe('Reset Functionality', () => {
		it('should reset colors when reset button is clicked', () => {
			render(
				<CustomThemeBuilder
					theme={mockTheme}
					customThemeColors={mockThemeColors}
					setCustomThemeColors={setCustomThemeColors}
					customThemeBaseId="dracula"
					setCustomThemeBaseId={setCustomThemeBaseId}
					isSelected={false}
					onSelect={onSelect}
				/>
			);

			const resetButton = screen.getByTitle('Reset to default');
			fireEvent.click(resetButton);
			fireEvent.click(screen.getByRole('button', { name: 'Reset' }));

			expect(setCustomThemeColors).toHaveBeenCalled();
			expect(setCustomThemeBaseId).toHaveBeenCalledWith('dracula');
		});
	});

	describe('Initialize From Base Theme', () => {
		it('should show base theme selector when initialize button is clicked', () => {
			render(
				<CustomThemeBuilder
					theme={mockTheme}
					customThemeColors={mockThemeColors}
					setCustomThemeColors={setCustomThemeColors}
					customThemeBaseId="dracula"
					setCustomThemeBaseId={setCustomThemeBaseId}
					isSelected={false}
					onSelect={onSelect}
				/>
			);

			// Click the initialize button
			const initializeButton = screen.getByRole('button', { name: /Initialize/i });
			fireEvent.click(initializeButton);

			// Dropdown should now be visible with theme options
			expect(screen.getByText('Monokai')).toBeInTheDocument();
			expect(screen.getByText('Nord')).toBeInTheDocument();
		});

		it('should initialize colors from a selected base theme', () => {
			render(
				<CustomThemeBuilder
					theme={mockTheme}
					customThemeColors={mockThemeColors}
					setCustomThemeColors={setCustomThemeColors}
					customThemeBaseId="dracula"
					setCustomThemeBaseId={setCustomThemeBaseId}
					isSelected={false}
					onSelect={onSelect}
				/>
			);

			fireEvent.click(screen.getByRole('button', { name: /Initialize/i }));
			fireEvent.click(screen.getByRole('button', { name: /Monokai/i }));

			expect(setCustomThemeColors).toHaveBeenCalledWith(THEMES.monokai.colors);
			expect(setCustomThemeBaseId).toHaveBeenCalledWith('monokai');
			expect(screen.queryByText('Nord')).not.toBeInTheDocument();
		});

		it('should close the selector without applying colors when a listed base theme is unavailable', () => {
			const themes = THEMES as unknown as Record<string, Theme>;
			themes.__missingBaseForTest = {
				...THEMES.dracula,
				id: 'missing-theme' as ThemeId,
				name: 'Missing Theme',
			};

			try {
				render(
					<CustomThemeBuilder
						theme={mockTheme}
						customThemeColors={mockThemeColors}
						setCustomThemeColors={setCustomThemeColors}
						customThemeBaseId="dracula"
						setCustomThemeBaseId={setCustomThemeBaseId}
						isSelected={false}
						onSelect={onSelect}
					/>
				);

				fireEvent.click(screen.getByRole('button', { name: /Initialize/i }));
				fireEvent.click(screen.getByRole('button', { name: /Missing Theme/i }));

				expect(setCustomThemeColors).not.toHaveBeenCalled();
				expect(setCustomThemeBaseId).not.toHaveBeenCalled();
				expect(screen.queryByText('Missing Theme')).not.toBeInTheDocument();
			} finally {
				delete themes.__missingBaseForTest;
			}
		});
	});

	describe('Color Input', () => {
		it('should render complex rgba colors with a neutral color picker and alpha marker', () => {
			const complexColors = {
				...mockThemeColors,
				accentDim: 'rgba(139,92,246,0.25)',
			};

			render(
				<CustomThemeBuilder
					theme={mockTheme}
					customThemeColors={complexColors}
					setCustomThemeColors={setCustomThemeColors}
					customThemeBaseId="dracula"
					setCustomThemeBaseId={setCustomThemeBaseId}
					isSelected={false}
					onSelect={onSelect}
				/>
			);

			expect(screen.getByTitle('Accent Dim')).toHaveValue('#888888');
			expect(screen.getByText('α')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'rgba(139,92,...' })).toBeInTheDocument();
		});

		it('should update color when color picker value changes', () => {
			render(
				<CustomThemeBuilder
					theme={mockTheme}
					customThemeColors={mockThemeColors}
					setCustomThemeColors={setCustomThemeColors}
					customThemeBaseId="dracula"
					setCustomThemeBaseId={setCustomThemeBaseId}
					isSelected={false}
					onSelect={onSelect}
				/>
			);

			// Find color input for bgMain
			const colorInputs = document.querySelectorAll('input[type="color"]');
			expect(colorInputs.length).toBeGreaterThan(0);

			// Change color
			fireEvent.change(colorInputs[0], { target: { value: '#ff0000' } });

			expect(setCustomThemeColors).toHaveBeenCalled();
		});

		it('should edit a color value from the inline text input', () => {
			render(
				<CustomThemeBuilder
					theme={mockTheme}
					customThemeColors={mockThemeColors}
					setCustomThemeColors={setCustomThemeColors}
					customThemeBaseId="dracula"
					setCustomThemeBaseId={setCustomThemeBaseId}
					isSelected={false}
					onSelect={onSelect}
				/>
			);

			const mainBackgroundRow = screen.getByText('Main Background').closest('div')?.parentElement
				?.parentElement as HTMLElement;
			fireEvent.click(within(mainBackgroundRow).getByRole('button', { name: '#1a1a2e' }));
			const textInput = screen
				.getAllByDisplayValue('#1a1a2e')
				.find((input) => input.getAttribute('type') === 'text')!;
			fireEvent.change(textInput, { target: { value: '#123456' } });
			fireEvent.keyDown(textInput, { key: 'Enter' });

			expect(setCustomThemeColors).toHaveBeenCalledWith({
				...mockThemeColors,
				bgMain: '#123456',
			});
			expect(document.querySelector('input[type="text"]')).not.toBeInTheDocument();
		});

		it('should close the inline color editor on blur', () => {
			render(
				<CustomThemeBuilder
					theme={mockTheme}
					customThemeColors={mockThemeColors}
					setCustomThemeColors={setCustomThemeColors}
					customThemeBaseId="dracula"
					setCustomThemeBaseId={setCustomThemeBaseId}
					isSelected={false}
					onSelect={onSelect}
				/>
			);

			const sidebarBackgroundRow = screen.getByText('Sidebar Background').closest('div')
				?.parentElement?.parentElement as HTMLElement;
			fireEvent.click(within(sidebarBackgroundRow).getByRole('button', { name: '#16213e' }));
			const textInput = screen
				.getAllByDisplayValue('#16213e')
				.find((input) => input.getAttribute('type') === 'text')!;
			fireEvent.blur(textInput);

			expect(document.querySelector('input[type="text"]')).not.toBeInTheDocument();
		});
	});

	describe('Import Button', () => {
		it('should open the hidden file input and ignore an empty file selection', () => {
			const inputClick = vi
				.spyOn(HTMLInputElement.prototype, 'click')
				.mockImplementation(() => undefined);

			render(
				<CustomThemeBuilder
					theme={mockTheme}
					customThemeColors={mockThemeColors}
					setCustomThemeColors={setCustomThemeColors}
					customThemeBaseId="dracula"
					setCustomThemeBaseId={setCustomThemeBaseId}
					isSelected={false}
					onSelect={onSelect}
					onImportError={onImportError}
					onImportSuccess={onImportSuccess}
				/>
			);

			fireEvent.click(screen.getByTitle('Import theme'));
			expect(inputClick).toHaveBeenCalledOnce();

			const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
			fireEvent.change(fileInput);

			expect(setCustomThemeColors).not.toHaveBeenCalled();
			expect(onImportError).not.toHaveBeenCalled();
			expect(onImportSuccess).not.toHaveBeenCalled();
		});
	});
});
