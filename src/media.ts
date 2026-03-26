import * as path from "node:path";
import type { SeaTalkClient } from "./client.js";
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

export async function resolveInboundMedia(params: {
	message: SeaTalkMessage;
	client: SeaTalkClient;
	log?: (msg: string) => void;
}): Promise<SeaTalkMediaInfo | null> {
	const { message, client, log } = params;
	const core = getSeatalkRuntime();

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

	let mediaUrlHost: string;
	try {
		mediaUrlHost = new URL(url).hostname;
	} catch {
		mediaUrlHost = "<invalid-url>";
	}
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
				contentType = await core.media.detectMime({ buffer: result.buffer });
			}

			const saved = await core.channel.media.saveMediaBuffer(
				result.buffer,
				contentType,
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
