import { z } from "zod";
export { z };

const DmPolicySchema = z.enum(["open", "allowlist", "pairing"]);
const GatewayModeSchema = z.enum(["webhook", "relay"]);
const GroupPolicySchema = z.enum(["disabled", "allowlist", "open"]);
const ProcessingIndicatorSchema = z.enum(["typing", "off"]);
const NativeCommandsSettingSchema = z.union([z.boolean(), z.literal("auto")]);

const SeaTalkChannelCommandsSchema = z
	.object({
		native: NativeCommandsSettingSchema.optional(),
		nativeSkills: NativeCommandsSettingSchema.optional(),
		text: z.boolean().optional(),
	})
	.strict()
	.optional();

export const SeaTalkToolsConfigSchema = z
	.object({
		groupInfo: z.boolean().optional().default(true),
		groupHistory: z.boolean().optional().default(true),
		groupList: z.boolean().optional().default(true),
		threadHistory: z.boolean().optional().default(true),
		getMessage: z.boolean().optional().default(true),
	})
	.strict();

export const SeaTalkAccountConfigSchema = z
	.object({
		enabled: z.boolean().optional(),
		appId: z.string().optional(),
		appSecret: z.string().optional(),
		signingSecret: z.string().optional(),
		mode: GatewayModeSchema.optional(),
		relayUrl: z.string().optional(),
		webhookPort: z.number().int().positive().optional(),
		webhookPath: z.string().optional(),
		dmPolicy: DmPolicySchema.optional(),
		allowFrom: z.array(z.string()).optional(),
		groupPolicy: GroupPolicySchema.optional(),
		groupAllowFrom: z.array(z.string()).optional(),
		groupSenderAllowFrom: z.array(z.string()).optional(),
		processingIndicator: ProcessingIndicatorSchema.optional(),
		mediaDownloadHosts: z.array(z.string()).optional(),
		commands: SeaTalkChannelCommandsSchema,
	})
	.strict();

export const SeaTalkConfigSchema = z
	.object({
		enabled: z.boolean().optional(),
		commands: SeaTalkChannelCommandsSchema,
		appId: z.string().optional(),
		appSecret: z.string().optional(),
		signingSecret: z.string().optional(),
		mode: GatewayModeSchema.optional().default("webhook"),
		relayUrl: z.string().optional(),
		webhookPort: z.number().int().positive().optional().default(8080),
		webhookPath: z.string().optional().default("/callback"),
		dmPolicy: DmPolicySchema.optional().default("allowlist"),
		allowFrom: z.array(z.string()).optional(),
		groupPolicy: GroupPolicySchema.optional().default("disabled"),
		groupAllowFrom: z.array(z.string()).optional(),
		groupSenderAllowFrom: z.array(z.string()).optional(),
		processingIndicator: ProcessingIndicatorSchema.optional().default("typing"),
		tools: SeaTalkToolsConfigSchema.optional(),
		mediaDownloadHosts: z.array(z.string()).optional(),
		accounts: z.record(z.string(), SeaTalkAccountConfigSchema.optional()).optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.dmPolicy === "open") {
			const allowFrom = value.allowFrom ?? [];
			const hasWildcard = allowFrom.some((entry) => entry.trim() === "*");
			if (!hasWildcard) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["allowFrom"],
					message:
						'channels.seatalk.dmPolicy="open" requires channels.seatalk.allowFrom to include "*"',
				});
			}
		}
	});
