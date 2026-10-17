import type { TelegramTestClient, TestBot, TestUser, TestChat } from "@emulators/telegram/test";

export interface SeedApi {
  bot(opts: BotSeed): Promise<TestBot>;
  user(opts: UserSeed): Promise<TestUser>;
  privateChat(bot: TestBot, user: TestUser): Promise<TestChat>;
  group(opts: GroupSeed): Promise<TestChat>;
  supergroup(opts: SupergroupSeed): Promise<TestChat>;
  channel(opts: ChannelSeed): Promise<TestChat>;
  forumTopic(chat: TestChat, name: string): Promise<{ message_thread_id: number; name: string }>;
}

export interface BotSeed {
  username: string;
  first_name?: string;
  token?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  commands?: Array<{ command: string; description: string }>;
}

export interface UserSeed {
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface GroupSeed {
  title: string;
  users: TestUser[];
  bots: TestBot[];
}

export interface SupergroupSeed extends GroupSeed {
  forum?: boolean;
}

export interface ChannelSeed {
  title: string;
  username?: string;
  bots: TestBot[];
  users?: TestUser[];
}

export function createSeed(tg: TelegramTestClient): SeedApi {
  return {
    async bot(opts) {
      return tg.createBot(opts);
    },
    async user(opts) {
      return tg.createUser(opts);
    },
    async privateChat(bot, user) {
      return tg.createPrivateChat({ botId: bot.bot_id, userId: user.id });
    },
    async group({ title, users, bots }) {
      return tg.createGroupChat({
        title,
        type: "group",
        memberIds: users.map((u) => u.id),
        botIds: bots.map((b) => b.bot_id),
      });
    },
    async supergroup({ title, users, bots }) {
      return tg.createSupergroup({
        title,
        memberIds: users.map((u) => u.id),
        botIds: bots.map((b) => b.bot_id),
      });
    },
    async channel({ title, username, bots, users }) {
      return tg.createChannel({
        title,
        username,
        memberBotIds: bots.map((b) => b.bot_id),
        memberUserIds: users?.map((u) => u.id),
      });
    },
    async forumTopic(chat, name) {
      return tg.createForumTopic({ chatId: chat.id, name });
    },
  };
}
