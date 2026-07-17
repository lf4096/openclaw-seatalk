import {
	type ChannelSetupDmPolicy,
	type ChannelSetupWizard,
	DEFAULT_ACCOUNT_ID,
	type OpenClawConfig,
	createStandardChannelSetupStatus,
	createTopLevelChannelDmPolicy,
	mergeAllowFromEntries,
} from "openclaw/plugin-sdk/setup";
import { resolveSeaTalkAccount } from "./accounts.js";
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
		(cfg.channels?.seatalk as SeaTalkConfig | undefined)?.dmPolicy ?? "allowlist",
	promptAllowFrom: async ({ cfg, prompter }) =>
		promptSeaTalkAllowFrom({ cfg: cfg as OpenClawConfig, prompter }),
});

async function promptCredentials(
	prompter: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"],
	requireSigningSecret: boolean,
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
	// WebSocket mode has no HMAC callback to verify, so the signing secret is not needed.
	const signingSecret = requireSigningSecret
		? String(
				await prompter.text({
					message: "Enter SeaTalk Signing Secret",
					validate: (value) => (value?.trim() ? undefined : "Required"),
				}),
			).trim()
		: "";
	return { appId, appSecret, signingSecret };
}

async function noteSeaTalkCredentialHelp(
	prompter: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"],
	requireSigningSecret: boolean,
): Promise<void> {
	const steps = [
		"Go to SeaTalk Open Platform (open.seatalk.io)",
		"Create a Bot App",
		"Get App ID and App Secret from Basic Info & Credentials",
		...(requireSigningSecret ? ["Get Signing Secret from Event Callback settings"] : []),
		"Enable Bot capability and set status to Online",
		'Enable "Send Message to Bot User" permission',
	];
	await prompter.note(
		steps.map((step, i) => `${i + 1}) ${step}`).join("\n"),
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
		resolveConfigured: ({ cfg }) => resolveSeaTalkAccount({ cfg }).configured,
	}),
	credentials: [],
	finalize: async ({ cfg, prompter, forceAllowFrom }) => {
		let next = cfg;
		const seatalkCfg = next.channels?.seatalk as SeaTalkConfig | undefined;

		// Ask the transport mode first so credential prompts can be mode-aware
		// (websocket authenticates with app_id + app_secret only, no signing secret).
		const currentMode = seatalkCfg?.mode ?? "webhook";
		const modeChoice = await prompter.select({
			message: "Gateway mode",
			options: [
				{
					value: "webhook",
					label: "Webhook — receive event callbacks on a public URL (default)",
				},
				{ value: "relay", label: "Relay — connect to a relay service as client" },
				{
					value: "websocket",
					label: "WebSocket — official SeaTalk direct connection (no public URL)",
				},
			],
			initialValue: currentMode,
		});
		const mode = String(modeChoice) as "webhook" | "relay" | "websocket";
		const requireSigningSecret = mode !== "websocket";

		const hasConfigCreds = Boolean(
			seatalkCfg?.appId?.trim() &&
				seatalkCfg?.appSecret?.trim() &&
				(!requireSigningSecret || seatalkCfg?.signingSecret?.trim()),
		);

		let appId: string | null = null;
		let appSecret: string | null = null;
		let signingSecret: string | null = null;

		if (!hasConfigCreds) {
			await noteSeaTalkCredentialHelp(prompter, requireSigningSecret);
		}

		if (hasConfigCreds) {
			const keep = await prompter.confirm({
				message: "SeaTalk credentials already configured. Keep them?",
				initialValue: true,
			});
			if (!keep) {
				({ appId, appSecret, signingSecret } = await promptCredentials(
					prompter,
					requireSigningSecret,
				));
			}
		} else {
			({ appId, appSecret, signingSecret } = await promptCredentials(
				prompter,
				requireSigningSecret,
			));
		}

		if (appId && appSecret) {
			const seatalkNext: Record<string, unknown> = {
				...next.channels?.seatalk,
				enabled: true,
				appId,
				appSecret,
				dmPolicy: seatalkCfg?.dmPolicy ?? "allowlist",
			};
			if (signingSecret) {
				seatalkNext.signingSecret = signingSecret;
			} else {
				// New credentials without a signing secret (websocket mode): drop the old
				// app's secret instead of silently pairing it with the replacement app.
				seatalkNext.signingSecret = undefined;
			}
			next = {
				...next,
				channels: {
					...next.channels,
					seatalk: seatalkNext,
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
				].join("\n"),
				"SeaTalk setup",
			);
		}

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

		if (mode === "websocket") {
			await prompter.note(
				[
					"Switch the bot to WebSocket in the SeaTalk portal (Event Callback settings).",
					"The gateway must already be connected before the portal 'Re-verify' passes.",
					"No public URL or signing secret is needed in this mode.",
				].join("\n"),
				"SeaTalk WebSocket",
			);
		} else if (mode === "relay") {
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

			await prompter.note(
				"Configure the public callback URL in the SeaTalk portal (Event Callback settings).",
				"SeaTalk webhook",
			);
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
