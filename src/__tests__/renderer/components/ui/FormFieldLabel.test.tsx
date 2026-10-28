/**
 * Tests for FormFieldLabel - the uppercase label above a form field, shared by
 * `FormInput` and by fields that are not a `FormInput`.
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FormFieldLabel } from '../../../../renderer/components/ui/FormFieldLabel';
import { mockTheme } from '../../../helpers/mockTheme';

function renderLabel(props: Partial<React.ComponentProps<typeof FormFieldLabel>> = {}) {
	const { container } = render(
		<FormFieldLabel theme={mockTheme} {...props}>
			API key variable
		</FormFieldLabel>
	);
	return container.firstElementChild as HTMLElement;
}

describe('FormFieldLabel', () => {
	it('draws the field-label spelling in the theme text color', () => {
		const label = renderLabel();
		expect(label.textContent).toBe('API key variable');
		expect(label).toHaveClass('block', 'text-xs', 'font-bold', 'opacity-70', 'uppercase', 'mb-2');
		expect(label).toHaveStyle({ color: mockTheme.colors.textMain });
	});

	it('is a real label bound to its control when given an id', () => {
		const label = renderLabel({ htmlFor: 'endpoint-url' });
		expect(label.tagName).toBe('LABEL');
		expect(label.getAttribute('for')).toBe('endpoint-url');
	});

	it('is a plain block when it names no control', () => {
		// A <label> with no `for` and no nested control is wrong markup.
		const label = renderLabel();
		expect(label.tagName).toBe('DIV');
		expect(label.hasAttribute('for')).toBe(false);
	});

	it('carries an optional test id', () => {
		expect(renderLabel({ testId: 'field-label' }).getAttribute('data-testid')).toBe('field-label');
		expect(renderLabel({ htmlFor: 'x', testId: 'field-label' }).getAttribute('data-testid')).toBe(
			'field-label'
		);
	});
});
