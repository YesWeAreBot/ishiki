import { Schema, Time } from "koishi";

export interface Profile {
  id: string;
  dataPath: string;
  model: string;
  initialFocus: { sid: string; channelId: string };
  allowedChannels: Array<{ sid: string; channels: string[] }>;
  keywords: string[];
  attention: { mentions: string[]; quoteSelf: boolean };
  context: {
    workspaceTokenLimit: number;
    idleMs: number;
    historyEntries: number;
    focusHistoryEntries: number;
    toolResultChars: number;
  };
  innerThought: boolean;
}

export interface ProfileConfig {
  profiles: Profile[];
}

export const ProfileConfig: Schema<ProfileConfig> = Schema.object({
  profiles: Schema.array(
    Schema.object({
      id: Schema.string().required(),
      dataPath: Schema.string().required(),
      model: Schema.string().required(),
      initialFocus: Schema.object({
        sid: Schema.string().required(),
        channelId: Schema.string().required(),
      }).required(),
      allowedChannels: Schema.array(
        Schema.object({
          sid: Schema.string()
            .pattern(/^\S+:\S+$/)
            .required()
            .description("bot account, e.g. onebot:1434974784"),
          channels: Schema.array(Schema.string()).required(),
        }),
      ).required(),
      keywords: Schema.array(Schema.string()).default([]),
      attention: Schema.object({
        mentions: Schema.array(Schema.string()).default([]),
        quoteSelf: Schema.boolean().default(false),
      }),
      context: Schema.object({
        workspaceTokenLimit: Schema.number().default(8192),
        idleMs: Schema.number().default(30 * Time.minute),
        historyEntries: Schema.number().default(40),
        focusHistoryEntries: Schema.number().default(40),
        toolResultChars: Schema.number().default(2000),
      }),
      innerThought: Schema.boolean().default(false),
    }),
  ).required(),
});
