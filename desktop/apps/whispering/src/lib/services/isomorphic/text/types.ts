import { createTaggedError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type {
	NativePasteResult,
	PasteBinding,
	PasteShortcut,
} from '$lib/privacy/policy';
import type { MaybePromise, WhisperingError } from '$lib/result';

const { TextServiceError, TextServiceErr } =
	createTaggedError('TextServiceError');
type TextServiceError = ReturnType<typeof TextServiceError>;
export { TextServiceErr, TextServiceError };

export type TextService = {
	/**
	 * Reads text from the system clipboard.
	 * @returns The text content of the clipboard, or null if empty.
	 */
	readFromClipboard: () => Promise<Result<string | null, TextServiceError>>;

	/**
	 * Copies text to the system clipboard.
	 * @param text The text to copy to the clipboard.
	 */
	copyToClipboard: (text: string) => Promise<Result<void, TextServiceError>>;

	/**
	 * Puts the text on the clipboard and, with a binding, pastes it at the
	 * cursor (Cmd+V on macOS, Ctrl+V elsewhere, Shift+Insert for mintty).
	 *
	 * VoiceFlow 0.9.23: with `keepClipboard`, a paste puts the person's own
	 * clipboard back once the app has read the text (best effort: when it
	 * can't be put back, the text stays). Without it, or when nothing is
	 * pasted, the text stays on the clipboard. Without a binding it is only
	 * copied.
	 *
	 * @param text The text to write at the cursor position.
	 */
	writeToCursor: (
		text: string,
		/**
		 * VoiceFlow: the window the paste was authorized for. The desktop
		 * paste checks it again right before the keystroke and stops (pasted:
		 * false) when another window or a password field is in front.
		 */
		binding?: PasteBinding,
		shortcut?: PasteShortcut,
		/** VoiceFlow 0.9.23: put the previous clipboard back after a paste. */
		keepClipboard?: boolean,
	) => MaybePromise<Result<PasteOutcome, TextServiceError | WhisperingError>>;

	/**
	 * Simulates pressing the Enter/Return key.
	 * Useful for automatically submitting text in chat applications after transcription.
	 *
	 * Note: This is only supported on desktop (Tauri). Web browsers cannot simulate keystrokes
	 * for security reasons.
	 */
	simulateEnterKeystroke: () => Promise<Result<void, TextServiceError>>;
};

/** VoiceFlow: what a paste did, as facts (Rust `PasteResult`). */
export type PasteOutcome = NativePasteResult;
