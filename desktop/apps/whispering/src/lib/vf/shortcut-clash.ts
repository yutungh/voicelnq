/**
 * VoiceFlow 0.9.23: Settings refuses keys another VoiceLnq shortcut already
 * uses (the system only tells about keys another app holds). Keys compare
 * the same whatever the order or case of their modifiers. Pure, so it is
 * unit tested.
 */

/**
 * One name per modifier, as the system registers it: older settings may
 * say CommandOrControl (Command on a Mac, Control elsewhere), Ctrl, Cmd,
 * Option or Super.
 */
function modifierName(part: string, isMac: boolean): string {
	switch (part) {
		case 'commandorcontrol':
		case 'cmdorctrl':
		case 'cmdorcontrol':
		case 'commandorctrl':
			return isMac ? 'command' : 'control';
		case 'ctrl':
			return 'control';
		case 'cmd':
		case 'meta':
		case 'super':
			return isMac ? 'command' : 'super';
		case 'command':
			return isMac ? 'command' : 'super';
		case 'option':
			return 'alt';
		default:
			return part;
	}
}

/** "Control+Alt+V", "alt+control+v" and "CommandOrControl+Alt+V" (on Windows) are the same keys. */
export function sameKeys(a: string, b: string, isMac = false): boolean {
	const norm = (keys: string) => {
		const parts = keys.split('+').map((p) => p.trim().toLowerCase());
		const key = parts.pop() ?? '';
		return [...parts.map((p) => modifierName(p, isMac)).sort(), key].join('+');
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
	isMac = false,
): string | null {
	for (const [id, other] of Object.entries(assigned)) {
		if (id !== commandId && other && sameKeys(other, keys, isMac)) return id;
	}
	return null;
}
