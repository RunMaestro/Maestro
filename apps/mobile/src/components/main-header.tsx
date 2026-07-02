/**
 * MainHeader - Header component for the chat screen
 *
 * Renders the AITabStrip for switching between AI tabs within the active session.
 * The tab strip is positioned at the top of the chat screen, above the conversation.
 */

import { AITabStrip } from './AITabStrip';

export function MainHeader() {
	return <AITabStrip />;
}
