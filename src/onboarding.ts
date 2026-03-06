import type {
	ChannelOnboardingAdapter,
	ChannelOnboardingDmPolicy,
	ClawdbotConfig,
	DmPolicy,
	WizardPrompter,
} from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, addWildcardAllowFrom } from "openclaw/plugin-sdk";
import { resolveSeaTalkCredentials } from "./accounts.js";
import { probeSeaTalk } from "./probe.js";
import type { SeaTalkConfig } from "./types.js";

const channel = "seatalk" as const;

function setSeaTalkDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy): ClawdbotConfig {
	const allowFrom =
		dmPolicy === "open"
			? addWildcardAllowFrom(cfg.channels?.seatalk?.allowFrom)?.map((entry) => String(entry))
			: undefined;
	return {
		...cfg,
		channels: {
			...cfg.channels,
			seatalk: {
				...cfg.channels?.seatalk,
				dmPolicy,
				...(allowFrom ? { allowFrom } : {}),
			},
		},
	};
}

function setSeaTalkAllowFrom(cfg: ClawdbotConfig, allowFrom: string[]): ClawdbotConfig {
	return {
		...cfg,
		channels: {
			...cfg.channels,
			seatalk: {
				...cfg.channels?.seatalk,
				allowFrom,
			},
		},
	};
}

function parseAllowFromInput(raw: string): string[] {
	return raw
		.split(/[\n,;]+/g)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

async function promptSeaTalkAllowFrom(params: {
	cfg: ClawdbotConfig;
	prompter: WizardPrompter;
}): Promise<ClawdbotConfig> {
	const existing = params.cfg.channels?.seatalk?.allowFrom ?? [];
	await params.prompter.note(
		[
			"Allowlist SeaTalk DMs by email or employee_code.",
			"Examples:",
			"- alice@company.com",
			"- e_12345678",
		].join("\n"),
		"SeaTalk allowlist",
	);

	while (true) {
		const entry = await params.prompter.text({
			message: "SeaTalk allowFrom (emails or employee_codes)",
			placeholder: "alice@company.com, e_xxxxx",
			initialValue: existing[0] ? String(existing[0]) : undefined,
			validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
		});
		const parts = parseAllowFromInput(String(entry));
		if (parts.length === 0) {
			await params.prompter.note("Enter at least one user.", "SeaTalk allowlist");
			continue;
		}

		const unique = [
			...new Set([
				...existing.map((v: string | number) => String(v).trim()).filter(Boolean),
				...parts,
			]),
		];
		return setSeaTalkAllowFrom(params.cfg, unique);
	}
}

async function promptCredentials(prompter: WizardPrompter): Promise<{
	appId: string;
	appSecret: string;
	signingSecret: string;
}> {
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

async function noteSeaTalkCredentialHelp(prompter: WizardPrompter): Promise<void> {
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

const dmPolicy: ChannelOnboardingDmPolicy = {
	label: "SeaTalk",
	channel,
	policyKey: "channels.seatalk.dmPolicy",
	allowFromKey: "channels.seatalk.allowFrom",
	getCurrent: (cfg) =>
		(cfg.channels?.seatalk as SeaTalkConfig | undefined)?.dmPolicy ?? "allowlist",
	setPolicy: (cfg, policy) => setSeaTalkDmPolicy(cfg, policy),
	promptAllowFrom: promptSeaTalkAllowFrom,
};

export const seatalkOnboardingAdapter: ChannelOnboardingAdapter = {
	channel,
	getStatus: async ({ cfg }) => {
		const seatalkCfg = cfg.channels?.seatalk as SeaTalkConfig | undefined;
		const configured = Boolean(resolveSeaTalkCredentials(seatalkCfg));

		let probeResult = null;
		if (configured && seatalkCfg) {
			try {
				probeResult = await probeSeaTalk({
					appId: seatalkCfg.appId,
					appSecret: seatalkCfg.appSecret,
				});
			} catch {
				// ignore
			}
		}

		const statusLines: string[] = [];
		if (!configured) {
			statusLines.push("SeaTalk: needs app credentials");
		} else if (probeResult?.ok) {
			statusLines.push(
				`SeaTalk: connected (appId: ${probeResult.appId}, latency: ${probeResult.latencyMs}ms)`,
			);
		} else {
			statusLines.push("SeaTalk: configured (connection not verified)");
		}

		return {
			channel,
			configured,
			statusLines,
			selectionHint: configured ? "configured" : "needs app creds",
			quickstartScore: configured ? 2 : 0,
		};
	},

	configure: async ({ cfg, prompter, forceAllowFrom }) => {
		const seatalkCfg = cfg.channels?.seatalk as SeaTalkConfig | undefined;
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

		let next = cfg;
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
							dmPolicy:
								(next.channels?.seatalk as SeaTalkConfig | undefined)?.dmPolicy ??
								"allowlist",
						},
					},
				};
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
						dmPolicy:
							(next.channels?.seatalk as SeaTalkConfig | undefined)?.dmPolicy ??
							"allowlist",
					},
				},
			};

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
		};

		if (mode === "relay") {
			const currentRelayUrl =
				(next.channels?.seatalk as SeaTalkConfig | undefined)?.relayUrl ?? "";
			const relayUrlInput = await prompter.text({
				message: "Relay WebSocket URL",
				placeholder: "ws://relay.example.com:8080/ws",
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
			next = {
				...next,
				channels: {
					...next.channels,
					seatalk: {
						...next.channels?.seatalk,
						relayUrl,
					},
				},
			};
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
				};
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
				};
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
		};

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
			const groupAllowFrom = parseAllowFromInput(String(groupInput));
			next = {
				...next,
				channels: {
					...next.channels,
					seatalk: {
						...next.channels?.seatalk,
						groupAllowFrom,
					},
				},
			};
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
					placeholder: "alice@company.com, e_12345678",
					initialValue:
						existingSenders.length > 0 ? existingSenders.join(", ") : undefined,
					validate: (value) =>
						String(value ?? "").trim() ? undefined : "Enter at least one user",
				});
				const groupSenderAllowFrom = parseAllowFromInput(String(senderInput));
				next = {
					...next,
					channels: {
						...next.channels,
						seatalk: {
							...next.channels?.seatalk,
							groupSenderAllowFrom,
						},
					},
				};
			}
		}

		const typingChoice = await prompter.select({
			message: "Typing indicator",
			options: [
				{
					value: "typing",
					label: "Typing — show typing status while processing (default)",
				},
				{ value: "off", label: "Off — no typing indicator" },
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
					processingIndicator: String(typingChoice),
				},
			},
		};

		if (forceAllowFrom) {
			next = await promptSeaTalkAllowFrom({ cfg: next, prompter });
		}

		return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
	},

	dmPolicy,

	disable: (cfg) => ({
		...cfg,
		channels: {
			...cfg.channels,
			seatalk: { ...cfg.channels?.seatalk, enabled: false },
		},
	}),
};
