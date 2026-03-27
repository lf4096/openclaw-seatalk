import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/core";
import {
	listSeaTalkAccountIds,
	resolveDefaultSeaTalkAccountId,
	resolveSeaTalkAccount,
} from "./accounts.js";
import { resolveSeaTalkClient } from "./client.js";
import { seatalkOutbound } from "./outbound.js";
import { probeSeaTalk } from "./probe.js";
import { seatalkSetupWizard } from "./setup-surface.js";
import { looksLikeEmail, looksLikeSeaTalkId, normalizeSeaTalkTarget } from "./targets.js";
import type { ResolvedSeaTalkAccount, SeaTalkConfig } from "./types.js";

const meta = {
	id: "seatalk",
	label: "SeaTalk",
	selectionLabel: "SeaTalk (plugin)",
	blurb: "SeaTalk internal messaging integration.",
	docsPath: "/channels/seatalk",
	aliases: [],
	order: 70,
	quickstartAllowFrom: true,
};

export const seatalkPlugin: ChannelPlugin<ResolvedSeaTalkAccount> = {
	id: "seatalk",
	meta,
	capabilities: {
		chatTypes: ["direct", "group"],
		polls: false,
		threads: true,
		media: true,
		reactions: false,
		edit: false,
		reply: false,
	},
	reload: { configPrefixes: ["channels.seatalk"] },
	configSchema: {
		schema: {
			type: "object",
			additionalProperties: false,
			properties: {
				enabled: { type: "boolean" },
				appId: { type: "string" },
				appSecret: { type: "string" },
				signingSecret: { type: "string" },
				mode: { type: "string", enum: ["webhook", "relay"] },
				relayUrl: { type: "string" },
				webhookPort: { type: "integer", minimum: 1 },
				webhookPath: { type: "string" },
				dmPolicy: { type: "string", enum: ["open", "allowlist"] },
				allowFrom: { type: "array", items: { type: "string" } },
				groupPolicy: { type: "string", enum: ["disabled", "allowlist", "open"] },
				groupAllowFrom: { type: "array", items: { type: "string" } },
				groupSenderAllowFrom: { type: "array", items: { type: "string" } },
				processingIndicator: { type: "string", enum: ["typing", "off"] },
				tools: {
					type: "object",
					properties: {
						groupInfo: { type: "boolean" },
						groupHistory: { type: "boolean" },
						groupList: { type: "boolean" },
						threadHistory: { type: "boolean" },
						getMessage: { type: "boolean" },
					},
				},
				accounts: {
					type: "object",
					additionalProperties: {
						type: "object",
						properties: {
							enabled: { type: "boolean" },
							appId: { type: "string" },
							appSecret: { type: "string" },
							signingSecret: { type: "string" },
							mode: { type: "string", enum: ["webhook", "relay"] },
							relayUrl: { type: "string" },
							webhookPort: { type: "integer", minimum: 1 },
							webhookPath: { type: "string" },
							dmPolicy: { type: "string", enum: ["open", "allowlist"] },
							allowFrom: { type: "array", items: { type: "string" } },
							groupPolicy: {
								type: "string",
								enum: ["disabled", "allowlist", "open"],
							},
							groupAllowFrom: { type: "array", items: { type: "string" } },
							groupSenderAllowFrom: { type: "array", items: { type: "string" } },
							processingIndicator: { type: "string", enum: ["typing", "off"] },
						},
					},
				},
			},
		},
	},
	config: {
		listAccountIds: (cfg) => listSeaTalkAccountIds(cfg),
		resolveAccount: (cfg, accountId) => resolveSeaTalkAccount({ cfg, accountId }),
		defaultAccountId: (cfg) => resolveDefaultSeaTalkAccountId(cfg),
		setAccountEnabled: ({ cfg, accountId, enabled }) => {
			const isDefault = accountId === DEFAULT_ACCOUNT_ID;

			if (isDefault) {
				return {
					...cfg,
					channels: {
						...cfg.channels,
						seatalk: {
							...cfg.channels?.seatalk,
							enabled,
						},
					},
				};
			}

			const seatalkCfg = cfg.channels?.seatalk as SeaTalkConfig | undefined;
			return {
				...cfg,
				channels: {
					...cfg.channels,
					seatalk: {
						...seatalkCfg,
						accounts: {
							...seatalkCfg?.accounts,
							[accountId]: {
								...seatalkCfg?.accounts?.[accountId],
								enabled,
							},
						},
					},
				},
			};
		},
		deleteAccount: ({ cfg, accountId }) => {
			const isDefault = accountId === DEFAULT_ACCOUNT_ID;

			if (isDefault) {
				const next = { ...cfg } as OpenClawConfig;
				const nextChannels = { ...cfg.channels } as Record<string, unknown>;
				nextChannels.seatalk = undefined;
				const hasOtherChannels = Object.values(nextChannels).some((v) => v !== undefined);
				next.channels = hasOtherChannels ? nextChannels : undefined;
				return next;
			}

			const seatalkCfg = cfg.channels?.seatalk as SeaTalkConfig | undefined;
			const accounts = { ...seatalkCfg?.accounts };
			delete accounts[accountId];

			return {
				...cfg,
				channels: {
					...cfg.channels,
					seatalk: {
						...seatalkCfg,
						accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
					},
				},
			};
		},
		isConfigured: (account) => account.configured,
		describeAccount: (account) => ({
			accountId: account.accountId,
			enabled: account.enabled,
			configured: account.configured,
			appId: account.appId,
			mode: account.mode,
			...(account.mode === "relay"
				? { relayUrl: account.relayUrl }
				: { webhookPort: account.webhookPort }),
		}),
		resolveAllowFrom: ({ cfg, accountId }) => {
			const account = resolveSeaTalkAccount({ cfg, accountId });
			return (account.config?.allowFrom ?? []).map((entry) => String(entry));
		},
		formatAllowFrom: ({ allowFrom }) =>
			allowFrom.map((entry) => String(entry).trim()).filter(Boolean),
	},
	security: {
		collectWarnings: ({ cfg, accountId }) => {
			const account = resolveSeaTalkAccount({ cfg, accountId });
			const seatalkCfg = account.config;
			const dmPolicy = seatalkCfg?.dmPolicy ?? "allowlist";
			if (dmPolicy !== "open") return [];
			return [
				`- SeaTalk[${account.accountId}]: dmPolicy="open" allows any subscriber to message the bot. Set channels.seatalk.dmPolicy="allowlist" + channels.seatalk.allowFrom to restrict senders.`,
			];
		},
	},
	setup: {
		resolveAccountId: () => DEFAULT_ACCOUNT_ID,
		applyAccountConfig: ({ cfg, accountId }) => {
			const isDefault = !accountId || accountId === DEFAULT_ACCOUNT_ID;

			if (isDefault) {
				return {
					...cfg,
					channels: {
						...cfg.channels,
						seatalk: {
							...cfg.channels?.seatalk,
							enabled: true,
						},
					},
				};
			}

			const seatalkCfg = cfg.channels?.seatalk as SeaTalkConfig | undefined;
			return {
				...cfg,
				channels: {
					...cfg.channels,
					seatalk: {
						...seatalkCfg,
						accounts: {
							...seatalkCfg?.accounts,
							[accountId]: {
								...seatalkCfg?.accounts?.[accountId],
								enabled: true,
							},
						},
					},
				},
			};
		},
	},
	setupWizard: seatalkSetupWizard,
	messaging: {
		normalizeTarget: (raw) => normalizeSeaTalkTarget(raw) ?? undefined,
		targetResolver: {
			looksLikeId: looksLikeSeaTalkId,
			hint: "<employee_code> or <email>",
		},
	},
	resolver: {
		resolveTargets: async ({ cfg, accountId, inputs }) => {
			const emailInputs = inputs.filter((i) => looksLikeEmail(i));
			if (emailInputs.length === 0) {
				return inputs.map((input) => ({ input, resolved: true, id: input }));
			}

			const passNonEmails = (note: string) =>
				inputs.map((input) => {
					const isEmail = looksLikeEmail(input);
					return {
						input,
						resolved: !isEmail,
						id: isEmail ? undefined : input,
						note: isEmail ? note : undefined,
					};
				});

			const account = resolveSeaTalkAccount({ cfg, accountId });
			const client = resolveSeaTalkClient(account);
			if (!client) {
				return passNonEmails("SeaTalk client not available");
			}

			const emailToCode = new Map<string, string>();
			try {
				const results = await client.getEmployeeCodeByEmail(emailInputs);
				for (const r of results) {
					if (r.employeeCode && r.status === 2) {
						emailToCode.set(r.email.toLowerCase(), r.employeeCode);
					}
				}
			} catch {
				return passNonEmails("Failed to resolve email");
			}

			return inputs.map((input) => {
				if (!looksLikeEmail(input)) {
					return { input, resolved: true, id: input };
				}
				const code = emailToCode.get(input.toLowerCase());
				if (code) {
					return { input, resolved: true, id: code, name: input };
				}
				return { input, resolved: false, note: "No active employee found for this email" };
			});
		},
	},
	outbound: seatalkOutbound,
	status: {
		defaultRuntime: {
			accountId: DEFAULT_ACCOUNT_ID,
			running: false,
			lastStartAt: null,
			lastStopAt: null,
			lastError: null,
			port: null,
		},
		buildChannelSummary: ({ snapshot }) => ({
			configured: snapshot.configured ?? false,
			running: snapshot.running ?? false,
			lastStartAt: snapshot.lastStartAt ?? null,
			lastStopAt: snapshot.lastStopAt ?? null,
			lastError: snapshot.lastError ?? null,
			port: snapshot.port ?? null,
			probe: snapshot.probe,
			lastProbeAt: snapshot.lastProbeAt ?? null,
		}),
		probeAccount: ({ account }) => probeSeaTalk(account),
		buildAccountSnapshot: ({ account, runtime, probe }) => ({
			accountId: account.accountId,
			enabled: account.enabled,
			configured: account.configured,
			appId: account.appId,
			mode: account.mode,
			...(account.mode === "relay"
				? { relayUrl: account.relayUrl }
				: { webhookPort: account.webhookPort }),
			running: runtime?.running ?? false,
			lastStartAt: runtime?.lastStartAt ?? null,
			lastStopAt: runtime?.lastStopAt ?? null,
			lastError: runtime?.lastError ?? null,
			port: runtime?.port ?? null,
			probe,
		}),
	},
	gateway: {
		startAccount: async (ctx) => {
			const account = resolveSeaTalkAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
			const mode = account.mode;

			if (mode === "relay") {
				if (!account.relayUrl) {
					throw new Error(
						`SeaTalk account "${ctx.accountId}" mode=relay but relayUrl is not configured`,
					);
				}
				ctx.setStatus({ accountId: ctx.accountId, mode: "relay" });
				ctx.log?.info(
					`starting seatalk[${ctx.accountId}] (relay client → ${account.relayUrl})`,
				);
				const { connectSeaTalkRelay } = await import("./relay-client.js");
				return connectSeaTalkRelay({
					config: ctx.cfg,
					runtime: ctx.runtime,
					abortSignal: ctx.abortSignal,
					accountId: ctx.accountId,
					relayUrl: account.relayUrl,
				});
			}

			ctx.setStatus({ accountId: ctx.accountId, port: account.webhookPort });
			ctx.log?.info(
				`starting seatalk[${ctx.accountId}] (webhook on port ${account.webhookPort})`,
			);
			const { monitorSeaTalkProvider } = await import("./monitor.js");
			return monitorSeaTalkProvider({
				config: ctx.cfg,
				runtime: ctx.runtime,
				abortSignal: ctx.abortSignal,
				accountId: ctx.accountId,
			});
		},
	},
};
