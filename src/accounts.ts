import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/core";
import type { ResolvedSeaTalkAccount, SeaTalkAccountConfig, SeaTalkConfig } from "./types.js";

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
	const accounts = (cfg.channels?.seatalk as SeaTalkConfig)?.accounts;
	if (!accounts || typeof accounts !== "object") {
		return [];
	}
	return Object.keys(accounts).filter(Boolean);
}

export function listSeaTalkAccountIds(cfg: OpenClawConfig): string[] {
	const ids = listConfiguredAccountIds(cfg);
	if (ids.length === 0) {
		return [DEFAULT_ACCOUNT_ID];
	}
	return [...ids].toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultSeaTalkAccountId(cfg: OpenClawConfig): string {
	const ids = listSeaTalkAccountIds(cfg);
	if (ids.includes(DEFAULT_ACCOUNT_ID)) {
		return DEFAULT_ACCOUNT_ID;
	}
	return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
	cfg: OpenClawConfig,
	accountId: string,
): SeaTalkAccountConfig | undefined {
	const accounts = (cfg.channels?.seatalk as SeaTalkConfig)?.accounts;
	if (!accounts || typeof accounts !== "object") {
		return undefined;
	}
	return accounts[accountId];
}

function mergeSeaTalkAccountConfig(cfg: OpenClawConfig, accountId: string): SeaTalkConfig {
	const seatalkCfg = cfg.channels?.seatalk as SeaTalkConfig | undefined;
	const { accounts: _ignored, ...base } = seatalkCfg ?? {};
	const account = resolveAccountConfig(cfg, accountId) ?? {};
	return { ...base, ...account } as SeaTalkConfig;
}

export function resolveSeaTalkCredentials(cfg?: SeaTalkConfig): {
	appId: string;
	appSecret: string;
	signingSecret: string;
} | null {
	const appId = (cfg?.appId ?? process.env.SEATALK_APP_ID)?.trim();
	const appSecret = (cfg?.appSecret ?? process.env.SEATALK_APP_SECRET)?.trim();
	const signingSecret = (cfg?.signingSecret ?? process.env.SEATALK_SIGNING_SECRET)?.trim();
	if (!appId || !appSecret || !signingSecret) {
		return null;
	}
	return { appId, appSecret, signingSecret };
}

export function resolveSeaTalkAccount(params: {
	cfg: OpenClawConfig;
	accountId?: string | null;
}): ResolvedSeaTalkAccount {
	const accountId = normalizeAccountId(params.accountId);
	const seatalkCfg = params.cfg.channels?.seatalk as SeaTalkConfig | undefined;

	const baseEnabled = seatalkCfg?.enabled !== false;
	const merged = mergeSeaTalkAccountConfig(params.cfg, accountId);
	const accountEnabled = merged.enabled !== false;
	const enabled = baseEnabled && accountEnabled;
	const creds = resolveSeaTalkCredentials(merged);

	return {
		accountId,
		enabled,
		configured: Boolean(creds),
		appId: creds?.appId,
		appSecret: creds?.appSecret,
		mode: merged.mode ?? "webhook",
		relayUrl: merged.relayUrl,
		webhookPort: merged.webhookPort ?? 8080,
		webhookPath: merged.webhookPath ?? "/callback",
		tools: merged.tools,
		config: merged,
	};
}

export function listEnabledSeaTalkAccounts(cfg: OpenClawConfig): ResolvedSeaTalkAccount[] {
	return listSeaTalkAccountIds(cfg)
		.map((accountId) => resolveSeaTalkAccount({ cfg, accountId }))
		.filter((account) => account.enabled && account.configured);
}
