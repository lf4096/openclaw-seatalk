import {
	type ChannelSetupDmPolicy,
	type ChannelSetupWizard,
	DEFAULT_ACCOUNT_ID,
	type OpenClawConfig,
	createStandardChannelSetupStatus,
	createTopLevelChannelDmPolicy,
	mergeAllowFromEntries,
} from "openclaw/plugin-sdk/setup";
import { resolveSeaTalkCredentials } from "./accounts.js";
import { probeSeaTalk } from "./probe.js";
import type { SeaTalkConfig } from "./types.js";

const channel = "seatalk" as const;

function parseAllowFromInput(raw: string): string[] {
	return raw
		.split(/[\n,;]+/g)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

async function promptSeaTalkAllowFrom(params: {
	cfg: OpenClawConfig;
	prompter: Parameters<NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>>[0]["prompter"];
}): Promise<OpenClawConfig> {
	const { cfg, prompter } = params;
	const existing = (cfg.channels?.seatalk as SeaTalkConfig | undefined)?.allowFrom ?? [];
	await prompter.note(
		[
			"Allowlist SeaTalk DMs by email or employee_code.",
			"Examples:",
			"- alice@company.com",
			"- 12345678",
		].join("\n"),
		"SeaTalk allowlist",
	);

	while (true) {
		const entry = await prompter.text({
			message: "SeaTalk allowFrom (emails or employee_codes)",
			placeholder: "alice@company.com, 12345678",
			initialValue: existing[0] ? String(existing[0]) : undefined,
			validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
		});
		const parts = parseAllowFromInput(String(entry));
		if (parts.length === 0) {
			await prompter.note("Enter at least one user.", "SeaTalk allowlist");
			continue;
		}

		const unique = mergeAllowFromEntries(
			existing.map((v) => String(v)),
			parts,
		);
		return {
			...cfg,
			channels: {
				...cfg.channels,
				seatalk: {
					...cfg.channels?.seatalk,
					allowFrom: unique,
				},
			},
		} as OpenClawConfig;
	}
}

const seatalkDmPolicy: ChannelSetupDmPolicy = createTopLevelChannelDmPolicy({
	label: "SeaTalk",
	channel,
	policyKey: "channels.seatalk.dmPolicy",
	allowFromKey: "channels.seatalk.allowFrom",
	getCurrent: (cfg) =>
		((cfg.channels?.seatalk as SeaTalkConfig | undefined)?.dmPolicy ?? "allowlist") as string,
	promptAllowFrom: async ({ cfg, prompter }) =>
		promptSeaTalkAllowFrom({ cfg: cfg as OpenClawConfig, prompter }),
});

async function promptCredentials(
	prompter: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"],
): Promise<{ appId: string; appSecret: string; signingSecret: string }> {
	const appId = String(
		await prompter.text({
			message: "Enter SeaTalk App ID",
			validate: (value) => (value?.trim() ? undefined : "Required"),
		}),
	).trim();
	const appSecret = String(
		await prompter.text({
			message: "Enter SeaTalk App Secret",
			validate: (value) => (value?.trim() ? undefined : "Required"),
		}),
	).trim();
	const signingSecret = String(
		await prompter.text({
			message: "Enter SeaTalk Signing Secret",
			validate: (value) => (value?.trim() ? undefined : "Required"),
		}),
	).trim();
	return { appId, appSecret, signingSecret };
}

async function noteSeaTalkCredentialHelp(
	prompter: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"],
): Promise<void> {
	await prompter.note(
		[
			"1) Go to SeaTalk Open Platform (open.seatalk.io)",
			"2) Create a Bot App",
			"3) Get App ID and App Secret from Basic Info & Credentials",
			"4) Get Signing Secret from Event Callback settings",
			"5) Enable Bot capability and set status to Online",
			'6) Enable "Send Message to Bot User" permission',
			"Tip: you can also set SEATALK_APP_ID / SEATALK_APP_SECRET / SEATALK_SIGNING_SECRET env vars.",
		].join("\n"),
		"SeaTalk credentials",
	);
}

export const seatalkSetupWizard: ChannelSetupWizard = {
	channel,
	status: createStandardChannelSetupStatus({
		channelLabel: "SeaTalk",
		configuredLabel: "configured",
		unconfiguredLabel: "needs app credentials",
		configuredHint: "configured",
		unconfiguredHint: "needs app creds",
		configuredScore: 2,
		unconfiguredScore: 0,
		resolveConfigured: ({ cfg }) => {
			const seatalkCfg = cfg.channels?.seatalk as SeaTalkConfig | undefined;
			return Boolean(resolveSeaTalkCredentials(seatalkCfg));
		},
	}),
	credentials: [],
	finalize: async ({ cfg, prompter, forceAllowFrom }) => {
		let next = cfg;
		const seatalkCfg = next.channels?.seatalk as SeaTalkConfig | undefined;
		const resolved = resolveSeaTalkCredentials(seatalkCfg);
		const hasConfigCreds = Boolean(
			seatalkCfg?.appId?.trim() &&
				seatalkCfg?.appSecret?.trim() &&
				seatalkCfg?.signingSecret?.trim(),
		);
		const canUseEnv = Boolean(
			!hasConfigCreds &&
				process.env.SEATALK_APP_ID?.trim() &&
				process.env.SEATALK_APP_SECRET?.trim() &&
				process.env.SEATALK_SIGNING_SECRET?.trim(),
		);

		let appId: string | null = null;
		let appSecret: string | null = null;
		let signingSecret: string | null = null;

		if (!resolved) {
			await noteSeaTalkCredentialHelp(prompter);
		}

		if (canUseEnv) {
			const keepEnv = await prompter.confirm({
				message:
					"SEATALK_APP_ID + SEATALK_APP_SECRET + SEATALK_SIGNING_SECRET detected. Use env vars?",
				initialValue: true,
			});
			if (keepEnv) {
				next = {
					...next,
					channels: {
						...next.channels,
						seatalk: {
							...next.channels?.seatalk,
							enabled: true,
							dmPolicy: seatalkCfg?.dmPolicy ?? "allowlist",
						},
					},
				} as OpenClawConfig;
			} else {
				({ appId, appSecret, signingSecret } = await promptCredentials(prompter));
			}
		} else if (hasConfigCreds) {
			const keep = await prompter.confirm({
				message: "SeaTalk credentials already configured. Keep them?",
				initialValue: true,
			});
			if (!keep) {
				({ appId, appSecret, signingSecret } = await promptCredentials(prompter));
			}
		} else {
			({ appId, appSecret, signingSecret } = await promptCredentials(prompter));
		}

		if (appId && appSecret && signingSecret) {
			next = {
				...next,
				channels: {
					...next.channels,
					seatalk: {
						...next.channels?.seatalk,
						enabled: true,
						appId,
						appSecret,
						signingSecret,
						dmPolicy: seatalkCfg?.dmPolicy ?? "allowlist",
					},
				},
			} as OpenClawConfig;

			try {
				const probe = await probeSeaTalk({ appId, appSecret });
				if (probe.ok) {
					await prompter.note(
						`Connected successfully (latency: ${probe.latencyMs}ms)`,
						"SeaTalk connection test",
					);
				} else {
					await prompter.note(
						`Connection failed: ${probe.error ?? "unknown error"}`,
						"SeaTalk connection test",
					);
				}
			} catch (err) {
				await prompter.note(
					`Connection test failed: ${String(err)}`,
					"SeaTalk connection test",
				);
			}

			await prompter.note(
				[
					"Important reminders:",
					'- Bot App must be set to "Online" status in SeaTalk Open Platform',
					'- "Send Message to Bot User" permission must be enabled',
					"- Configure the callback URL in Event Callback settings",
				].join("\n"),
				"SeaTalk setup",
			);
		}

		const currentMode =
			(next.channels?.seatalk as SeaTalkConfig | undefined)?.mode ?? "webhook";
		const modeChoice = await prompter.select({
			message: "Gateway mode",
			options: [
				{ value: "webhook", label: "Webhook — receive event callbacks directly (default)" },
				{ value: "relay", label: "Relay — connect to a relay service as client" },
			],
			initialValue: currentMode,
		});
		const mode = String(modeChoice) as "webhook" | "relay";

		next = {
			...next,
			channels: {
				...next.channels,
				seatalk: {
					...next.channels?.seatalk,
					mode,
				},
			},
		} as OpenClawConfig;

		if (mode === "relay") {
			const currentRelayUrl =
				(next.channels?.seatalk as SeaTalkConfig | undefined)?.relayUrl ?? "";
			const relayUrlInput = await prompter.text({
				message: "Relay WebSocket URL",
				placeholder: "wss://relay.example.com/ws",
				initialValue: currentRelayUrl || undefined,
				validate: (value) => {
					const v = String(value ?? "").trim();
					if (!v) return "Required";
					if (!v.startsWith("ws://") && !v.startsWith("wss://"))
						return "Must be a ws:// or wss:// URL";
					return undefined;
				},
			});
			const relayUrl = String(relayUrlInput).trim();
			if (relayUrl.startsWith("ws://")) {
				await prompter.note(
					"ws:// transmits credentials (appSecret, signingSecret) unencrypted. Consider using wss:// for production.",
					"Security warning",
				);
			}
			next = {
				...next,
				channels: {
					...next.channels,
					seatalk: {
						...next.channels?.seatalk,
						relayUrl,
					},
				},
			} as OpenClawConfig;
		} else {
			const currentPort =
				(next.channels?.seatalk as SeaTalkConfig | undefined)?.webhookPort ?? 8080;
			const portInput = await prompter.text({
				message: "Webhook port",
				initialValue: String(currentPort),
				validate: (value) => {
					const n = Number(value);
					return n > 0 && n < 65536 ? undefined : "Enter a valid port number (1-65535)";
				},
			});
			const port = Number(portInput);
			if (port && port !== currentPort) {
				next = {
					...next,
					channels: {
						...next.channels,
						seatalk: {
							...next.channels?.seatalk,
							webhookPort: port,
						},
					},
				} as OpenClawConfig;
			}

			const currentPath =
				(next.channels?.seatalk as SeaTalkConfig | undefined)?.webhookPath ?? "/callback";
			const pathInput = await prompter.text({
				message: "Webhook path",
				initialValue: currentPath,
				validate: (value) => {
					const v = String(value ?? "").trim();
					if (!v) return "Required";
					if (!v.startsWith("/")) return "Path must start with /";
					return undefined;
				},
			});
			const webhookPath = String(pathInput ?? currentPath).trim();
			if (webhookPath && webhookPath !== currentPath) {
				next = {
					...next,
					channels: {
						...next.channels,
						seatalk: {
							...next.channels?.seatalk,
							webhookPath,
						},
					},
				} as OpenClawConfig;
			}
		}

		const groupPolicyChoice = await prompter.select({
			message: "Group chat policy",
			options: [
				{ value: "disabled", label: "Disabled — ignore all group messages (default)" },
				{ value: "allowlist", label: "Allowlist — respond only in specific groups" },
				{ value: "open", label: "Open — respond in all groups the bot joins" },
			],
			initialValue:
				(next.channels?.seatalk as SeaTalkConfig | undefined)?.groupPolicy ?? "disabled",
		});
		const groupPolicy = String(groupPolicyChoice) as "disabled" | "allowlist" | "open";

		next = {
			...next,
			channels: {
				...next.channels,
				seatalk: {
					...next.channels?.seatalk,
					groupPolicy,
				},
			},
		} as OpenClawConfig;

		if (groupPolicy === "allowlist") {
			const existingGroups =
				(next.channels?.seatalk as SeaTalkConfig | undefined)?.groupAllowFrom ?? [];
			const groupInput = await prompter.text({
				message: "Allowed group IDs (comma-separated)",
				placeholder: "group_abc123, group_def456",
				initialValue: existingGroups.length > 0 ? existingGroups.join(", ") : undefined,
				validate: (value) =>
					String(value ?? "").trim() ? undefined : "Enter at least one group ID",
			});
			next = {
				...next,
				channels: {
					...next.channels,
					seatalk: {
						...next.channels?.seatalk,
						groupAllowFrom: parseAllowFromInput(String(groupInput)),
					},
				},
			} as OpenClawConfig;
		}

		if (groupPolicy !== "disabled") {
			const wantSenderFilter = await prompter.confirm({
				message: "Restrict which users can trigger the bot in groups? (sender allowlist)",
				initialValue: true,
			});
			if (wantSenderFilter) {
				const existingSenders =
					(next.channels?.seatalk as SeaTalkConfig | undefined)?.groupSenderAllowFrom ??
					[];
				const senderInput = await prompter.text({
					message: "Sender allowlist (emails or employee_codes, comma-separated)",
					placeholder: "alice@company.com, 12345678",
					initialValue:
						existingSenders.length > 0 ? existingSenders.join(", ") : undefined,
					validate: (value) =>
						String(value ?? "").trim() ? undefined : "Enter at least one user",
				});
				next = {
					...next,
					channels: {
						...next.channels,
						seatalk: {
							...next.channels?.seatalk,
							groupSenderAllowFrom: parseAllowFromInput(String(senderInput)),
						},
					},
				} as OpenClawConfig;
			}
		}

		const processingIndicator = await prompter.select({
			message: "Processing indicator",
			options: [
				{
					value: "typing",
					label: "Typing — show typing status while processing (default)",
				},
				{ value: "off", label: "Off — no processing indicator" },
			],
			initialValue:
				(next.channels?.seatalk as SeaTalkConfig | undefined)?.processingIndicator ??
				"typing",
		});
		next = {
			...next,
			channels: {
				...next.channels,
				seatalk: {
					...next.channels?.seatalk,
					processingIndicator: String(processingIndicator),
				},
			},
		} as OpenClawConfig;

		if (forceAllowFrom) {
			next = await promptSeaTalkAllowFrom({ cfg: next, prompter });
		}

		return { cfg: next };
	},
	dmPolicy: seatalkDmPolicy,
	disable: (cfg) => ({
		...cfg,
		channels: {
			...cfg.channels,
			seatalk: { ...cfg.channels?.seatalk, enabled: false },
		},
	}),
};
