/**
 * FormFieldLabel - the small uppercase label above a form field.
 *
 * `FormInput` draws it for its own input. A field that is NOT a `FormInput`
 * (an autocomplete, a picker) still needs the same label so a form reads as one
 * set of fields, and writing the class string out again is how the copies drift
 * on weight and dimming. The Settings style guide also reads a bare
 * `font-bold uppercase` class in a tab as a hand-rolled section heading, so a
 * field label in Settings goes through this component.
 *
 * With `htmlFor` it is a real `<label>` bound to that control. Without one it is
 * a plain block, because a `<label>` that names no control is wrong markup.
 */

import type { ReactNode } from 'react';
import type { Theme } from '../../types';

export interface FormFieldLabelProps {
	theme: Theme;
	/** Id of the control this label names. Omit when the control takes no id. */
	htmlFor?: string;
	children: ReactNode;
	testId?: string;
}

const FORM_FIELD_LABEL_CLASS = 'block text-xs font-bold opacity-70 uppercase mb-2';

export function FormFieldLabel({ theme, htmlFor, children, testId }: FormFieldLabelProps) {
	const style = { color: theme.colors.textMain };
	if (htmlFor) {
		return (
			<label
				htmlFor={htmlFor}
				className={FORM_FIELD_LABEL_CLASS}
				style={style}
				data-testid={testId}
			>
				{children}
			</label>
		);
	}
	return (
		<div className={FORM_FIELD_LABEL_CLASS} style={style} data-testid={testId}>
			{children}
		</div>
	);
}

export default FormFieldLabel;
