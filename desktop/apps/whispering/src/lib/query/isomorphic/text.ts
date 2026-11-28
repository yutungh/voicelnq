import type { PasteBinding, PasteShortcut } from '$lib/privacy/policy';
import { defineMutation, defineQuery } from '$lib/query/client';
import { services } from '$lib/services';

const textKeys = {
	clipboard: ['text', 'clipboard'] as const,
	readFromClipboard: ['text', 'readFromClipboard'] as const,
	copyToClipboard: ['text', 'copyToClipboard'] as const,
	writeToCursor: ['text', 'writeToCursor'] as const,
	simulateEnterKeystroke: ['text', 'simulateEnterKeystroke'] as const,
} as const;

export const text = {
	readFromClipboard: defineQuery({
		queryKey: textKeys.readFromClipboard,
		queryFn: () => services.text.readFromClipboard(),
	}),
	copyToClipboard: defineMutation({
		mutationKey: ['text', 'copyToClipboard'],
		mutationFn: ({ text }: { text: string }) =>
			services.text.copyToClipboard(text),
	}),
	writeToCursor: defineMutation({
		mutationKey: ['text', 'writeToCursor'],
		mutationFn: async ({
			text,
			binding,
			shortcut,
			keepClipboard,
		}: {
			text: string;
			/** VoiceFlow: the window the paste was authorized for; none: copy only. */
			binding?: PasteBinding;
			/** VoiceFlow 0.9.11: the paste keys (Shift+Insert for mintty). */
			shortcut?: PasteShortcut;
			/** VoiceFlow 0.9.23: put the previous clipboard back after a paste. */
			keepClipboard?: boolean;
		}) => {
			// VoiceFlow 0.9.11: writes the clipboard, re-checks the window, sends
			// the paste keys. 0.9.23: with keepClipboard, the previous clipboard
			// is put back after a paste; otherwise the text stays there.
			return await services.text.writeToCursor(text, binding, shortcut, keepClipboard);
		},
	}),
	simulateEnterKeystroke: defineMutation({
		mutationKey: textKeys.simulateEnterKeystroke,
		mutationFn: () => services.text.simulateEnterKeystroke(),
	}),
};
