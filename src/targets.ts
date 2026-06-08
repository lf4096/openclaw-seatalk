// Legacy marker persisted by older plugin versions; new code emits bare ids.
const LEGACY_GROUP_PREFIX = "group:";

export function normalizeSeaTalkTarget(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	return trimmed;
}

export function looksLikeEmail(raw: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}

// SeaTalk employee codes are emails or <=10-digit numbers; group ids are longer
// base64 strings. Classify by id shape so DM/group routing needs no prefix.
// A legacy "group:" prefix (older persisted targets) is still honored.
export function resolveSeaTalkTargetKind(raw: string): {
	kind: "direct" | "group";
	id: string;
} {
	const trimmed = raw.trim();
	if (trimmed.startsWith(LEGACY_GROUP_PREFIX)) {
		return { kind: "group", id: trimmed.slice(LEGACY_GROUP_PREFIX.length) };
	}
	if (looksLikeEmail(trimmed) || /^\d{1,10}$/.test(trimmed)) {
		return { kind: "direct", id: trimmed };
	}
	return { kind: "group", id: trimmed };
}

export function looksLikeSeaTalkId(raw: string): boolean {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	if (looksLikeEmail(trimmed)) return true;
	if (trimmed.startsWith(LEGACY_GROUP_PREFIX)) {
		return trimmed.length > LEGACY_GROUP_PREFIX.length;
	}
	return /^[A-Za-z0-9_+/=-]+$/.test(trimmed);
}
