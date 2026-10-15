import type { MessagingPlatform } from "../types";

export interface MessagingAdapter {
  readonly platform: MessagingPlatform;
  listChannels(query?: string): Promise<{ id: string; name: string }[]>;
  /** Send `text` to the channel as the signed-in user. Resolves with the platform's message id when it reports one. */
  send(channelId: string, text: string, idempotencyKey: string): Promise<{ id?: string }>;
}
