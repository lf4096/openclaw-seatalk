import * as path from "node:path";
import { SEATALK_DEFAULT_MEDIA_DOWNLOAD_HOSTS, type SeaTalkClient } from "./client.js";
import { readLocalMedia } from "./media-local.js";
import { getSeatalkRuntime } from "./runtime.js";
import type { SeaTalkMediaInfo, SeaTalkMessage, SeaTalkOutboundMedia } from "./types.js";

const PLACEHOLDER_MAP: Record<string, string> = {
	image: "<media:image>",
	file: "<media:document>",
	video: "<media:video>",
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif"]);
const MAX_OUTBOUND_RAW_BYTES = 3.75 * 1024 * 1024; // ~3.75MB raw → 5MB base64
const SMALL_FILE_THRESHOLD = 10 * 1024 * 1024; // 10MB
const MAX_INBOUND_SAVE_BYTES = 250 * 1024 * 1024; // 250MB

// #region Inbound media URL policy

/** Build lowercase hostname allowlist; empty config falls back to SeaTalk OpenAPI host. */
export function resolveMediaDownloadHostAllowlist(configured?: string[] | null): Set<string> {
	const raw =
		configured && configured.length > 0
			? configured
			: [...SEATALK_DEFAULT_MEDIA_DOWNLOAD_HOSTS];
	return new Set(raw.map((h) => h.trim().toLowerCase()).filter(Boolean));
}

function gateInboundMediaUrl(
	urlString: string,
	allowedHosts: Set<string>,
): { ok: true; hostname: string } | { ok: false; detail: string } {
	let parsed: URL;
	try {
		parsed = new URL(urlString);
	} catch {
		return { ok: false, detail: "invalid URL" };
	}
	if (parsed.protocol !== "https:") {
		return { ok: false, detail: `only https allowed (got ${parsed.protocol})` };
	}
	const hostname = parsed.hostname.toLowerCase();
	if (!allowedHosts.has(hostname)) {
		return { ok: false, detail: `host not in allowlist (${hostname})` };
	}
	return { ok: true, hostname };
}

// #endregion

export async function resolveInboundMedia(params: {
	message: SeaTalkMessage;
	client: SeaTalkClient;
	/** When set and non-empty, replaces default `openapi.seatalk.io`-only allowlist. */
	mediaDownloadHosts?: string[] | null;
	log?: (msg: string) => void;
}): Promise<SeaTalkMediaInfo | null> {
	const { message, client, log, mediaDownloadHosts } = params;
	const core = getSeatalkRuntime();
	const allowedHosts = resolveMediaDownloadHostAllowlist(mediaDownloadHosts);

	let url: string | undefined;
	let filename: string | undefined;
	let placeholder = PLACEHOLDER_MAP.file;

	switch (message.tag) {
		case "image":
			url = message.image?.content;
			placeholder = PLACEHOLDER_MAP.image;
			break;
		case "file":
			url = message.file?.content;
			filename = message.file?.filename;
			break;
		case "video":
			url = message.video?.content;
			placeholder = PLACEHOLDER_MAP.video;
			break;
		default:
			return null;
	}

	if (!url) return null;

	const gate = gateInboundMediaUrl(url, allowedHosts);
	if (!gate.ok) {
		log?.(`seatalk: rejected inbound ${message.tag} media before download: ${gate.detail}`);
		return null;
	}
	const mediaUrlHost = gate.hostname;
	log?.(`seatalk: inbound ${message.tag} media url host=${mediaUrlHost}`);

	const MAX_RETRY = 1;

	for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
		try {
			const result = await client.downloadMedia(url);
			let contentType = result.contentType;

			if (
				(!contentType || contentType === "application/octet-stream") &&
				result.buffer.length < SMALL_FILE_THRESHOLD
			) {
				const detected = await core.media.detectMime({ buffer: result.buffer });
				if (detected) {
					contentType = detected;
				}
			}

			const saved = await core.channel.media.saveMediaBuffer(
				result.buffer,
				contentType ?? "application/octet-stream",
				"inbound",
				MAX_INBOUND_SAVE_BYTES,
				filename,
			);

			log?.(`seatalk: downloaded ${message.tag} media, saved to ${saved.path}`);

			return {
				path: saved.path,
				contentType: saved.contentType,
				filename,
				placeholder,
			};
		} catch (err) {
			if (attempt < MAX_RETRY) {
				log?.(
					`seatalk: retry ${attempt + 1}/${MAX_RETRY} downloading ${message.tag} media: ${String(err)}`,
				);
				continue;
			}
			log?.(
				`seatalk: failed to download ${message.tag} media after ${MAX_RETRY + 1} attempts: ${String(err)}`,
			);
			return null;
		}
	}

	return null;
}

async function fetchRemoteMedia(url: string): Promise<{ buffer: Buffer; name: string }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 30_000);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) {
			throw new Error(`Failed to fetch media from ${url}: HTTP ${res.status}`);
		}
		const arrayBuffer = await res.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);
		const urlPath = new URL(url).pathname;
		return { buffer, name: path.basename(urlPath) || "file" };
	} finally {
		clearTimeout(timeout);
	}
}

export async function prepareOutboundMedia(mediaUrl: string): Promise<SeaTalkOutboundMedia | null> {
	const isRemote = mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://");
	const { buffer, name: detectedName } = isRemote
		? await fetchRemoteMedia(mediaUrl)
		: readLocalMedia(mediaUrl);

	if (buffer.length > MAX_OUTBOUND_RAW_BYTES) {
		throw new Error(
			`Media file too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB exceeds ~3.75MB limit`,
		);
	}

	const ext = path.extname(detectedName).toLowerCase();
	const sendAs = IMAGE_EXTENSIONS.has(ext) ? "image" : "file";
	const base64 = buffer.toString("base64");

	return {
		base64,
		sendAs,
		filename: sendAs === "file" ? detectedName.slice(0, 100) : undefined,
	};
}

export function buildSeaTalkMediaPayload(mediaList: SeaTalkMediaInfo[]): {
	MediaPath?: string;
	MediaType?: string;
	MediaUrl?: string;
	MediaPaths?: string[];
	MediaUrls?: string[];
	MediaTypes?: string[];
} {
	const first = mediaList[0];
	const mediaPaths = mediaList.map((m) => m.path);
	const mediaTypes = mediaList.map((m) => m.contentType).filter(Boolean) as string[];
	return {
		MediaPath: first?.path,
		MediaType: first?.contentType,
		MediaUrl: first?.path,
		MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
		MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
		MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
	};
}
