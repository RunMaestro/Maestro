/**
 * The default a new browser tab opens at, re-exported under the name the Settings
 * pane uses. NOT a second copy of the value: this used to hard-code its own URL,
 * so "Reset to default" in Settings and the store's own default could disagree
 * about what the default even was - and after the store moved to a blank page,
 * the reset button would have put the old landing page back.
 */
export { DEFAULT_BROWSER_TAB_URL as DEFAULT_BROWSER_HOME_URL } from '../../../../../utils/browserTabPersistence';
