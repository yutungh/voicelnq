/**
 * VoiceFlow 0.9.23: Settings refuses keys another VoiceLnq shortcut already
 * uses (the system only tells about keys another app holds). Keys compare
 * the same whatever the order or case of their modifiers. Pure, so it is
 * unit tested.
 */

/** "Control+Alt+V" and "alt+control+v" are the same keys. */
export function sameKeys(a: string, b: string): boolean {
	const norm = (keys: string) => {
		const parts = keys.split('+').map((p) => p.trim().toLowerCase());
		const key = parts.pop() ?? '';
		return [...parts.sort(), key].join('+');
	};
	return norm(a) === norm(b);
}

/**
 * The id of the other command that already uses `keys`, if any.
 * `assigned` maps each command id to its keys (null: off).
 */
export function shortcutTakenBy(
	keys: string,
	commandId: string,
	assigned: Readonly<Record<string, string | null | undefined>>,
): string | null {
	for (const [id, other] of Object.entries(assigned)) {
		if (id !== commandId && other && sameKeys(other, keys)) return id;
	}
	return null;
}
