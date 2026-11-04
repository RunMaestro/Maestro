export { ChatComposer, type ChatComposerProps, type MentionRoster } from './ChatComposer';
export {
	ChatComposerFrame,
	useChatComposerFold,
	type ChatComposerFold,
	type ChatComposerFrameProps,
	type ChatComposerToolbarProps,
	type ChatComposerVoice,
} from './ChatComposerFrame';
export {
	ComposerSendColumn,
	type ComposerSendColumnProps,
	type ComposerSendMenu,
} from './ComposerSendColumn';
export { ComposerTextarea, type ComposerTextareaProps } from './ComposerTextarea';
export {
	ImageAttachInput,
	stageImageFiles,
	type ImageAttachInputProps,
	type StageImageFilesOptions,
} from './ImageAttachInput';
export {
	PhoneComposerHandle,
	type PhoneComposerHandleProps,
} from '../InputArea/components/PhoneComposerHandle';
export { applyTrimmedTextPaste, clipboardHasImage } from './pasteTrim';
export {
	GROUP_CHAT_COMPOSER_CAPABILITIES,
	MODERATOR_CANNOT_READ_IMAGES_MESSAGE,
	REMOVE_ATTACHED_IMAGES_TO_SEND_DETAIL,
	aiCanAttachImages,
	canModeratorReadImages,
	deriveAiComposerCapabilities,
	deriveGroupChatComposerCapabilities,
	flashModeratorCannotReadImages,
	type AiComposerCapabilitiesInput,
	type AiImageAttachInput,
	type ComposerCapabilities,
	type GroupChatComposerCapabilitiesInput,
	type ModeratorCapabilitiesState,
} from './capabilities';
