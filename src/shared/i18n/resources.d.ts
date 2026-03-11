/**
 * i18next Module Augmentation
 *
 * Declares the resource types so that t('common:save') and
 * similar calls get autocompletion and type checking.
 *
 * @see https://www.i18next.com/overview/typescript
 */

import type { I18nResources } from './types';

declare module 'i18next' {
	interface CustomTypeOptions {
		defaultNS: 'common';
		resources: I18nResources;
	}
}
