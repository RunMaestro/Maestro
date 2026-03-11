/**
 * useI18n — Typed convenience wrapper around react-i18next's useTranslation.
 *
 * Re-exports useTranslation with Maestro's namespace types so consumers
 * get autocompletion on namespace names and translation keys.
 *
 * Usage:
 *   const { t } = useI18n();           // defaults to 'common' namespace
 *   const { t } = useI18n('settings'); // specific namespace
 */

import { useTranslation } from 'react-i18next';
import type { I18nNamespace } from '../../shared/i18n/config';

export function useI18n(ns?: I18nNamespace | I18nNamespace[]) {
	return useTranslation(ns);
}
