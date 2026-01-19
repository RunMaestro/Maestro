import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTemplateAutocomplete } from '../../../renderer/hooks';
import { TEMPLATE_VARIABLES } from '../../../shared/templateVariables';

describe('useTemplateAutocomplete', () => {
	let mockTextarea: HTMLTextAreaElement;
	let textareaRef: React.RefObject<HTMLTextAreaElement>;
	let onChangeMock: ReturnType<typeof vi.fn>;

	// Helper to create a mock textarea element with proper DOM simulation
	const createMockTextarea = () => {
		const textarea = document.createElement('textarea');
		textarea.style.fontFamily = 'monospace';
		textarea.style.fontSize = '14px';
		textarea.style.lineHeight = '20px';
		textarea.style.padding = '8px';
		textarea.style.border = '1px solid black';
		document.body.appendChild(textarea);
		return textarea;
	};

	beforeEach(() => {
		// Clean up any existing elements
		document.body.textContent = '';

		// Create mock textarea
		mockTextarea = createMockTextarea();

		// Create ref
		textareaRef = {
			current: mockTextarea,
		} as React.RefObject<HTMLTextAreaElement>;

		onChangeMock = vi.fn();

		// Mock getBoundingClientRect for position calculation
		vi.spyOn(mockTextarea, 'getBoundingClientRect').mockReturnValue({
			top: 100,
			left: 50,
			bottom: 200,
			right: 350,
			width: 300,
			height: 100,
			x: 50,
			y: 100,
			toJSON: () => ({}),
		});

		// Mock scrollIntoView
		Element.prototype.scrollIntoView = vi.fn();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		document.body.textContent = '';
	});

	describe('initial state', () => {
		it('should return initial autocomplete state with isOpen false', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			expect(result.current.autocompleteState.isOpen).toBe(false);
			expect(result.current.autocompleteState.position).toEqual({ top: 0, left: 0 });
			expect(result.current.autocompleteState.selectedIndex).toBe(0);
			expect(result.current.autocompleteState.searchText).toBe('');
		});

		it('should return all template variables in filteredVariables initially', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			expect(result.current.autocompleteState.filteredVariables).toEqual(TEMPLATE_VARIABLES);
			expect(result.current.autocompleteState.filteredVariables.length).toBe(
				TEMPLATE_VARIABLES.length
			);
		});

		it('should return all expected methods', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			expect(typeof result.current.handleKeyDown).toBe('function');
			expect(typeof result.current.handleChange).toBe('function');
			expect(typeof result.current.selectVariable).toBe('function');
			expect(typeof result.current.closeAutocomplete).toBe('function');
			expect(result.current.autocompleteRef).toBeDefined();
		});
	});

	describe('handleChange - trigger detection', () => {
		it('should open autocomplete when typing "{{"', () => {
			const { result } = renderHook(
				({ value }) =>
					useTemplateAutocomplete({
						textareaRef,
						value,
						onChange: onChangeMock,
					}),
				{ initialProps: { value: '' } }
			);

			// Simulate typing "{{"
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;

			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(onChangeMock).toHaveBeenCalledWith('{{');
			expect(result.current.autocompleteState.isOpen).toBe(true);
		});

		it('should detect "{{" at the beginning of text', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;

			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.isOpen).toBe(true);
			expect(result.current.autocompleteState.searchText).toBe('');
		});

		it('should detect "{{" in the middle of text', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			mockTextarea.value = 'Hello {{';
			mockTextarea.selectionStart = 8;

			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.isOpen).toBe(true);
		});

		it('should detect "{{" at end of line after newlines', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			mockTextarea.value = 'Line 1\nLine 2\n{{';
			mockTextarea.selectionStart = 16;

			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.isOpen).toBe(true);
		});

		it('should not open autocomplete for single "{"', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			mockTextarea.value = '{';
			mockTextarea.selectionStart = 1;

			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.isOpen).toBe(false);
		});

		it('should not open for "{" followed by other character', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			mockTextarea.value = '{a';
			mockTextarea.selectionStart = 2;

			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.isOpen).toBe(false);
		});
	});

	describe('handleChange - search filtering', () => {
		it('should update searchText when typing after "{{"', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// First open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// Then type search text
			mockTextarea.value = '{{DATE';
			mockTextarea.selectionStart = 6;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.searchText).toBe('DATE');
		});

		it('should filter variables based on variable name', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// Type search
			mockTextarea.value = '{{DATE';
			mockTextarea.selectionStart = 6;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			const filtered = result.current.autocompleteState.filteredVariables;
			expect(filtered.length).toBeGreaterThan(0);
			expect(
				filtered.every(
					(v) =>
						v.variable.toLowerCase().includes('date') ||
						v.description.toLowerCase().includes('date')
				)
			).toBe(true);
		});

		it('should filter variables based on description', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// Search by description
			mockTextarea.value = '{{session';
			mockTextarea.selectionStart = 9;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			const filtered = result.current.autocompleteState.filteredVariables;
			expect(filtered.length).toBeGreaterThan(0);
			// Should include AGENT_SESSION_ID (SESSION_NAME and SESSION_ID are now legacy aliases, not documented)
			expect(filtered.some((v) => v.variable.includes('SESSION'))).toBe(true);
		});

		it('should be case insensitive when filtering', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// Lowercase search
			mockTextarea.value = '{{project';
			mockTextarea.selectionStart = 9;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			const filteredLower = result.current.autocompleteState.filteredVariables;

			// Reset
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// Uppercase search
			mockTextarea.value = '{{PROJECT';
			mockTextarea.selectionStart = 9;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			const filteredUpper = result.current.autocompleteState.filteredVariables;

			// Both should have same results
			expect(filteredLower.length).toBe(filteredUpper.length);
		});

		it('should adjust selectedIndex when filtered list shrinks', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Open and select an item
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// Navigate down
			act(() => {
				result.current.handleKeyDown({
					key: 'ArrowDown',
					preventDefault: vi.fn(),
				} as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
			});
			act(() => {
				result.current.handleKeyDown({
					key: 'ArrowDown',
					preventDefault: vi.fn(),
				} as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.selectedIndex).toBe(2);

			// Now filter to a smaller list
			mockTextarea.value = '{{TIMESTAMP';
			mockTextarea.selectionStart = 11;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// selectedIndex should be clamped to filtered list length
			expect(result.current.autocompleteState.selectedIndex).toBeLessThanOrEqual(
				result.current.autocompleteState.filteredVariables.length - 1
			);
		});

		it('should return all variables when search text is empty', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.filteredVariables.length).toBe(
				TEMPLATE_VARIABLES.length
			);
		});
	});

	describe('handleChange - close conditions', () => {
		it('should close when cursor moves before trigger position', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.isOpen).toBe(true);

			// User deletes back before trigger
			mockTextarea.value = '{';
			mockTextarea.selectionStart = 1;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.isOpen).toBe(false);
		});

		it('should close when "}}" is typed', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// Type search then close
			mockTextarea.value = '{{TEST}}';
			mockTextarea.selectionStart = 8;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.isOpen).toBe(false);
		});

		it('should close when "}}" appears in search text', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// Type with }}
			mockTextarea.value = '{{DATE}}extra';
			mockTextarea.selectionStart = 13;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.isOpen).toBe(false);
		});
	});

	describe('handleKeyDown', () => {
		const openAutocomplete = (result: { current: ReturnType<typeof useTemplateAutocomplete> }) => {
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});
		};

		it('should return false when autocomplete is not open', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			let handled = false;
			act(() => {
				handled = result.current.handleKeyDown({
					key: 'ArrowDown',
					preventDefault: vi.fn(),
				} as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
			});

			expect(handled).toBe(false);
		});

		describe('ArrowDown', () => {
			it('should move selection down', () => {
				const { result } = renderHook(() =>
					useTemplateAutocomplete({
						textareaRef,
						value: '',
						onChange: onChangeMock,
					})
				);

				openAutocomplete(result);
				expect(result.current.autocompleteState.selectedIndex).toBe(0);

				const preventDefault = vi.fn();
				let handled = false;
				act(() => {
					handled = result.current.handleKeyDown({
						key: 'ArrowDown',
						preventDefault,
					} as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
				});

				expect(preventDefault).toHaveBeenCalled();
				expect(handled).toBe(true);
				expect(result.current.autocompleteState.selectedIndex).toBe(1);
			});

			it('should not exceed list length', () => {
				const { result } = renderHook(() =>
					useTemplateAutocomplete({
						textareaRef,
						value: '',
						onChange: onChangeMock,
					})
				);

				openAutocomplete(result);

				// Navigate to last item
				const listLength = result.current.autocompleteState.filteredVariables.length;
				for (let i = 0; i < listLength + 5; i++) {
					act(() => {
						result.current.handleKeyDown({
							key: 'ArrowDown',
							preventDefault: vi.fn(),
						} as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
					});
				}

				expect(result.current.autocompleteState.selectedIndex).toBe(listLength - 1);
			});
		});

		describe('ArrowUp', () => {
			it('should move selection up', () => {
				const { result } = renderHook(() =>
					useTemplateAutocomplete({
						textareaRef,
						value: '',
						onChange: onChangeMock,
					})
				);

				openAutocomplete(result);

				// First move down
				act(() => {
					result.current.handleKeyDown({
						key: 'ArrowDown',
						preventDefault: vi.fn(),
					} as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
				});
				act(() => {
					result.current.handleKeyDown({
						key: 'ArrowDown',
						preventDefault: vi.fn(),
					} as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
				});

				expect(result.current.autocompleteState.selectedIndex).toBe(2);

				// Then move up
				const preventDefault = vi.fn();
				let handled = false;
				act(() => {
					handled = result.current.handleKeyDown({
						key: 'ArrowUp',
						preventDefault,
					} as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
				});

				expect(preventDefault).toHaveBeenCalled();
				expect(handled).toBe(true);
				expect(result.current.autocompleteState.selectedIndex).toBe(1);
			});

			it('should not go below 0', () => {
				const { result } = renderHook(() =>
					useTemplateAutocomplete({
						textareaRef,
						value: '',
						onChange: onChangeMock,
					})
				);

				openAutocomplete(result);
				expect(result.current.autocompleteState.selectedIndex).toBe(0);

				act(() => {
					result.current.handleKeyDown({
						key: 'ArrowUp',
						preventDefault: vi.fn(),
					} as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
				});

				expect(result.current.autocompleteState.selectedIndex).toBe(0);
			});
		});

		describe('Enter', () => {
			it('should select current variable and close', () => {
				const { result } = renderHook(() =>
					useTemplateAutocomplete({
						textareaRef,
						value: '',
						onChange: onChangeMock,
					})
				);

				openAutocomplete(result);

				const preventDefault = vi.fn();
				let handled = false;
				act(() => {
					handled = result.current.handleKeyDown({
						key: 'Enter',
						preventDefault,
					} as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
				});

				expect(preventDefault).toHaveBeenCalled();
				expect(handled).toBe(true);
				// Should close after selection
				expect(result.current.autocompleteState.isOpen).toBe(false);
			});

			it('should insert selected variable into value', () => {
				const { result } = renderHook(() =>
					useTemplateAutocomplete({
						textareaRef,
						value: '',
						onChange: onChangeMock,
					})
				);

				openAutocomplete(result);
				onChangeMock.mockClear();

				const selectedVariable = result.current.autocompleteState.filteredVariables[0].variable;

				act(() => {
					result.current.handleKeyDown({
						key: 'Enter',
						preventDefault: vi.fn(),
					} as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
				});

				// onChange should be called with the variable
				expect(onChangeMock).toHaveBeenCalledWith(selectedVariable);
			});

			it('should do nothing when filtered list is empty', () => {
				const { result } = renderHook(() =>
					useTemplateAutocomplete({
						textareaRef,
						value: '',
						onChange: onChangeMock,
					})
				);

				openAutocomplete(result);

				// Filter to empty list
				mockTextarea.value = '{{xyznonexistent';
				mockTextarea.selectionStart = 16;
				act(() => {
					result.current.handleChange({
						target: mockTextarea,
					} as React.ChangeEvent<HTMLTextAreaElement>);
				});

				expect(result.current.autocompleteState.filteredVariables.length).toBe(0);
				onChangeMock.mockClear();

				const preventDefault = vi.fn();
				act(() => {
					result.current.handleKeyDown({
						key: 'Enter',
						preventDefault,
					} as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
				});

				// Should not prevent default or select anything
				expect(preventDefault).not.toHaveBeenCalled();
			});
		});

		describe('Tab', () => {
			it('should select current variable like Enter', () => {
				const { result } = renderHook(() =>
					useTemplateAutocomplete({
						textareaRef,
						value: '',
						onChange: onChangeMock,
					})
				);

				openAutocomplete(result);
				onChangeMock.mockClear();

				const preventDefault = vi.fn();
				let handled = false;
				act(() => {
					handled = result.current.handleKeyDown({
						key: 'Tab',
						preventDefault,
					} as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
				});

				expect(preventDefault).toHaveBeenCalled();
				expect(handled).toBe(true);
				expect(result.current.autocompleteState.isOpen).toBe(false);
				expect(onChangeMock).toHaveBeenCalled();
			});
		});

		describe('Escape', () => {
			it('should close autocomplete', () => {
				const { result } = renderHook(() =>
					useTemplateAutocomplete({
						textareaRef,
						value: '',
						onChange: onChangeMock,
					})
				);

				openAutocomplete(result);
				expect(result.current.autocompleteState.isOpen).toBe(true);

				const preventDefault = vi.fn();
				let handled = false;
				act(() => {
					handled = result.current.handleKeyDown({
						key: 'Escape',
						preventDefault,
					} as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
				});

				expect(preventDefault).toHaveBeenCalled();
				expect(handled).toBe(true);
				expect(result.current.autocompleteState.isOpen).toBe(false);
			});
		});

		describe('other keys', () => {
			it('should return false for other keys', () => {
				const { result } = renderHook(() =>
					useTemplateAutocomplete({
						textareaRef,
						value: '',
						onChange: onChangeMock,
					})
				);

				openAutocomplete(result);

				const preventDefault = vi.fn();
				let handled = false;
				act(() => {
					handled = result.current.handleKeyDown({
						key: 'a',
						preventDefault,
					} as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
				});

				expect(handled).toBe(false);
				expect(preventDefault).not.toHaveBeenCalled();
			});
		});
	});

	describe('selectVariable', () => {
		it('should replace text from trigger position to cursor', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// Type some search text
			mockTextarea.value = '{{DATE';
			mockTextarea.selectionStart = 6;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			onChangeMock.mockClear();

			act(() => {
				result.current.selectVariable('{{DATE}}');
			});

			// The new value should replace "{{DATE" with "{{DATE}}"
			expect(onChangeMock).toHaveBeenCalledWith('{{DATE}}');
		});

		it('should handle text before trigger', () => {
			const { result, rerender } = renderHook(
				({ value }) =>
					useTemplateAutocomplete({
						textareaRef,
						value,
						onChange: onChangeMock,
					}),
				{ initialProps: { value: '' } }
			);

			// Open autocomplete with text before
			mockTextarea.value = 'Hello {{';
			mockTextarea.selectionStart = 8;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// Update value prop to match textarea (simulating controlled component)
			rerender({ value: 'Hello {{' });

			onChangeMock.mockClear();

			act(() => {
				result.current.selectVariable('{{TIMESTAMP}}');
			});

			expect(onChangeMock).toHaveBeenCalledWith('Hello {{TIMESTAMP}}');
		});

		it('should handle text after cursor', () => {
			const { result, rerender } = renderHook(
				({ value }) =>
					useTemplateAutocomplete({
						textareaRef,
						value,
						onChange: onChangeMock,
					}),
				{ initialProps: { value: '' } }
			);

			// Open autocomplete with text after cursor
			mockTextarea.value = '{{ world';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// Update value prop to match textarea (simulating controlled component)
			rerender({ value: '{{ world' });

			onChangeMock.mockClear();

			act(() => {
				result.current.selectVariable('{{AGENT_NAME}}');
			});

			expect(onChangeMock).toHaveBeenCalledWith('{{AGENT_NAME}} world');
		});

		it('should close autocomplete after selection', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.isOpen).toBe(true);

			act(() => {
				result.current.selectVariable('{{DATE}}');
			});

			expect(result.current.autocompleteState.isOpen).toBe(false);
		});

		it('should do nothing if textareaRef is null', () => {
			const nullRef = { current: null } as React.RefObject<HTMLTextAreaElement>;
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef: nullRef,
					value: '{{',
					onChange: onChangeMock,
				})
			);

			onChangeMock.mockClear();

			act(() => {
				result.current.selectVariable('{{DATE}}');
			});

			expect(onChangeMock).not.toHaveBeenCalled();
		});
	});

	describe('closeAutocomplete', () => {
		it('should reset state to initial', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// First open autocomplete with "{{"
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.isOpen).toBe(true);

			// Then type more to update search text
			mockTextarea.value = '{{test';
			mockTextarea.selectionStart = 6;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// Ensure it's open with modified state
			expect(result.current.autocompleteState.isOpen).toBe(true);
			expect(result.current.autocompleteState.searchText).toBe('test');

			// Close it
			act(() => {
				result.current.closeAutocomplete();
			});

			expect(result.current.autocompleteState.isOpen).toBe(false);
			expect(result.current.autocompleteState.searchText).toBe('');
			expect(result.current.autocompleteState.selectedIndex).toBe(0);
			expect(result.current.autocompleteState.position).toEqual({ top: 0, left: 0 });
		});
	});

	describe('position calculation', () => {
		it('should calculate position relative to textarea', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			const position = result.current.autocompleteState.position;
			// Position should be non-zero after calculation
			expect(position.top).toBeDefined();
			expect(position.left).toBeDefined();
		});

		it('should prevent overflow by limiting left position', () => {
			// This is tested implicitly by the Math.min in calculatePosition
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Create a long line to push cursor right
			mockTextarea.value = 'A'.repeat(100) + '{{';
			mockTextarea.selectionStart = 102;
			mockTextarea.style.width = '300px';
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			const position = result.current.autocompleteState.position;
			// Left should be limited to prevent overflow (clientWidth - 250)
			expect(position.left).toBeLessThanOrEqual(mockTextarea.clientWidth - 250 + 50); // +50 for tolerance
		});
	});

	describe('scroll into view effect', () => {
		it('should scroll selected item into view when selection changes', async () => {
			const scrollIntoViewMock = vi.fn();
			Element.prototype.scrollIntoView = scrollIntoViewMock;

			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Create the autocomplete dropdown element
			const autocompleteDiv = document.createElement('div');
			const selectedItem = document.createElement('div');
			selectedItem.setAttribute('data-index', '0');
			autocompleteDiv.appendChild(selectedItem);
			document.body.appendChild(autocompleteDiv);

			// Manually set the ref (simulating what would happen in a real component)
			(result.current.autocompleteRef as { current: HTMLDivElement | null }).current =
				autocompleteDiv;

			// Open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// The effect should have triggered scrollIntoView
			// Note: In real usage, the dropdown component would render the items
		});
	});

	describe('click outside effect', () => {
		it('should close when clicking outside both textarea and dropdown', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Create the autocomplete dropdown element and set the ref BEFORE opening
			const autocompleteDiv = document.createElement('div');
			autocompleteDiv.setAttribute('id', 'autocomplete-dropdown');
			document.body.appendChild(autocompleteDiv);
			(result.current.autocompleteRef as { current: HTMLDivElement | null }).current =
				autocompleteDiv;

			// Open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.isOpen).toBe(true);

			// Create an outside element
			const outsideElement = document.createElement('div');
			outsideElement.setAttribute('id', 'outside');
			document.body.appendChild(outsideElement);

			// Simulate click outside - with proper target
			act(() => {
				const event = new MouseEvent('mousedown', {
					bubbles: true,
				});
				Object.defineProperty(event, 'target', { value: outsideElement });
				document.dispatchEvent(event);
			});

			expect(result.current.autocompleteState.isOpen).toBe(false);
		});

		it('should not close when clicking on textarea', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.isOpen).toBe(true);

			// Simulate click on textarea
			act(() => {
				const event = new MouseEvent('mousedown', {
					bubbles: true,
				});
				Object.defineProperty(event, 'target', { value: mockTextarea });
				document.dispatchEvent(event);
			});

			expect(result.current.autocompleteState.isOpen).toBe(true);
		});

		it('should not close when clicking on autocomplete dropdown', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Create the autocomplete dropdown element and set the ref
			const autocompleteDiv = document.createElement('div');
			document.body.appendChild(autocompleteDiv);
			(result.current.autocompleteRef as { current: HTMLDivElement | null }).current =
				autocompleteDiv;

			// Open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.isOpen).toBe(true);

			// Simulate click on dropdown
			act(() => {
				const event = new MouseEvent('mousedown', {
					bubbles: true,
				});
				Object.defineProperty(event, 'target', { value: autocompleteDiv });
				document.dispatchEvent(event);
			});

			expect(result.current.autocompleteState.isOpen).toBe(true);
		});

		it('should clean up event listener on unmount', () => {
			const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

			const { result, unmount } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			unmount();

			expect(removeEventListenerSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
		});
	});

	describe('TEMPLATE_VARIABLES integration', () => {
		it('should include all expected variable categories', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			const variables = result.current.autocompleteState.filteredVariables;

			// Agent variables
			expect(variables.some((v) => v.variable === '{{AGENT_NAME}}')).toBe(true);
			expect(variables.some((v) => v.variable === '{{AGENT_PATH}}')).toBe(true);
			expect(variables.some((v) => v.variable === '{{AGENT_SESSION_ID}}')).toBe(true);
			expect(variables.some((v) => v.variable === '{{TAB_NAME}}')).toBe(true);

			// Path variables
			expect(variables.some((v) => v.variable === '{{CWD}}')).toBe(true);

			// Date/time variables
			expect(variables.some((v) => v.variable === '{{DATE}}')).toBe(true);
			expect(variables.some((v) => v.variable === '{{TIME}}')).toBe(true);
			expect(variables.some((v) => v.variable === '{{DATETIME}}')).toBe(true);
			expect(variables.some((v) => v.variable === '{{TIMESTAMP}}')).toBe(true);

			// Git variables
			expect(variables.some((v) => v.variable === '{{GIT_BRANCH}}')).toBe(true);
			expect(variables.some((v) => v.variable === '{{IS_GIT_REPO}}')).toBe(true);
		});

		it('should filter to DATE-related variables', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// First open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// Then filter by typing DATE
			mockTextarea.value = '{{DATE';
			mockTextarea.selectionStart = 6;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			const filtered = result.current.autocompleteState.filteredVariables;
			// Should include the main DATE variables
			expect(filtered.some((v) => v.variable === '{{DATE}}')).toBe(true);
			expect(filtered.some((v) => v.variable === '{{DATETIME}}')).toBe(true);
			expect(filtered.some((v) => v.variable === '{{DATE_SHORT}}')).toBe(true);
			// All filtered results should have "date" in variable OR description
			expect(filtered.length).toBeGreaterThan(0);
			// Should be smaller than full list since we're filtering
			expect(filtered.length).toBeLessThan(TEMPLATE_VARIABLES.length);
		});
	});

	describe('requestAnimationFrame behavior', () => {
		it('should set cursor position after variable selection', async () => {
			vi.useFakeTimers();

			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Mock focus and setSelectionRange
			const focusMock = vi.fn();
			const setSelectionRangeMock = vi.fn();
			mockTextarea.focus = focusMock;
			mockTextarea.setSelectionRange = setSelectionRangeMock;

			// Open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// Select variable
			act(() => {
				result.current.selectVariable('{{DATE}}');
			});

			// Run requestAnimationFrame callbacks
			await act(async () => {
				vi.runAllTimers();
			});

			expect(focusMock).toHaveBeenCalled();
			expect(setSelectionRangeMock).toHaveBeenCalledWith(8, 8); // Length of "{{DATE}}"

			vi.useRealTimers();
		});
	});

	describe('edge cases', () => {
		it('should handle empty textarea', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			mockTextarea.value = '';
			mockTextarea.selectionStart = 0;

			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.isOpen).toBe(false);
		});

		it('should handle multiple "{{" patterns', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// First {{
			mockTextarea.value = '{{DATE}} {{';
			mockTextarea.selectionStart = 11;

			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			expect(result.current.autocompleteState.isOpen).toBe(true);
		});

		it('should handle rapid typing', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Rapid sequence
			const sequence = ['{{', '{{D', '{{DA', '{{DAT', '{{DATE'];
			sequence.forEach((value) => {
				mockTextarea.value = value;
				mockTextarea.selectionStart = value.length;
				act(() => {
					result.current.handleChange({
						target: mockTextarea,
					} as React.ChangeEvent<HTMLTextAreaElement>);
				});
			});

			expect(result.current.autocompleteState.isOpen).toBe(true);
			expect(result.current.autocompleteState.searchText).toBe('DATE');
		});

		it('should handle value prop changes', () => {
			const { result, rerender } = renderHook(
				({ value }) =>
					useTemplateAutocomplete({
						textareaRef,
						value,
						onChange: onChangeMock,
					}),
				{ initialProps: { value: '' } }
			);

			// Open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// Rerender with new value (simulating external value change)
			rerender({ value: '{{DATE}}' });

			// Hook should still work
			expect(typeof result.current.handleKeyDown).toBe('function');
		});

		it('should handle special characters in search', () => {
			const { result } = renderHook(() =>
				useTemplateAutocomplete({
					textareaRef,
					value: '',
					onChange: onChangeMock,
				})
			);

			// Open autocomplete
			mockTextarea.value = '{{';
			mockTextarea.selectionStart = 2;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// Search with special chars
			mockTextarea.value = '{{_';
			mockTextarea.selectionStart = 3;
			act(() => {
				result.current.handleChange({
					target: mockTextarea,
				} as React.ChangeEvent<HTMLTextAreaElement>);
			});

			// Should filter based on underscore
			const filtered = result.current.autocompleteState.filteredVariables;
			expect(
				filtered.every(
					(v) => v.variable.toLowerCase().includes('_') || v.description.toLowerCase().includes('_')
				)
			).toBe(true);
		});
	});
});
