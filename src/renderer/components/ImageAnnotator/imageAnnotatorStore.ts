/**
 * imageAnnotatorStore — Controls visibility and payload of the full-screen
 * image annotation modal.
 *
 * Callers (InputArea, GroupChatInput, AutoRun thumbnails, lightbox modals) open
 * the annotator with the source image data URL and a save callback; the modal
 * invokes the callback with the composited PNG data URL when the user saves.
 */

import { create } from 'zustand';

interface ImageAnnotatorState {
	isOpen: boolean;
	imageDataUrl: string | null;
	onSave: ((newDataUrl: string) => void) | null;
	openAnnotator: (imageDataUrl: string, onSave: (newDataUrl: string) => void) => void;
	closeAnnotator: () => void;
}

export const useImageAnnotatorStore = create<ImageAnnotatorState>((set) => ({
	isOpen: false,
	imageDataUrl: null,
	onSave: null,
	openAnnotator: (imageDataUrl, onSave) => set({ isOpen: true, imageDataUrl, onSave }),
	closeAnnotator: () => set({ isOpen: false, imageDataUrl: null, onSave: null }),
}));
