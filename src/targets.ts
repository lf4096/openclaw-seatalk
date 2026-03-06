const GROUP_PREFIX = "group:";

export function normalizeSeaTalkTarget(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	return trimmed;
}

export function isGroupTarget(to: string): boolean {
	return to.startsWith(GROUP_PREFIX);
}

export function parseGroupTarget(to: string): string {
	return to.slice(GROUP_PREFIX.length);
}

export function looksLikeEmail(raw: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}

export function looksLikeSeaTalkId(raw: string): boolean {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	if (looksLikeEmail(trimmed)) return true;
	if (isGroupTarget(trimmed)) return parseGroupTarget(trimmed).length > 0;
	return /^[a-zA-Z0-9_-]+$/.test(trimmed);
}
