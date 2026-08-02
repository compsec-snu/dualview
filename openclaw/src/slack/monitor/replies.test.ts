import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const hookRunnerMock = {
  hasHooks: vi.fn((_name?: string) => false),
  runMessageSending: vi.fn(
    async (..._args: unknown[]): Promise<{ content?: string; cancel?: boolean } | undefined> =>
      undefined,
  ),
};
vi.mock("../send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMock(...args),
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunnerMock,
}));

import { deliverReplies, deliverSlackSlashReplies } from "./replies.js";

function baseParams(overrides?: Record<string, unknown>) {
  return {
    replies: [{ text: "hello" }],
    target: "C123",
    token: "xoxb-test",
    runtime: { log: () => {}, error: () => {}, exit: () => {} },
    textLimit: 4000,
    replyToMode: "off" as const,
    ...overrides,
  };
}

describe("deliverReplies identity passthrough", () => {
  beforeEach(() => {
    sendMock.mockReset();
    hookRunnerMock.hasHooks.mockReset();
    hookRunnerMock.hasHooks.mockReturnValue(false);
    hookRunnerMock.runMessageSending.mockReset();
    hookRunnerMock.runMessageSending.mockResolvedValue(undefined);
  });
  it("passes identity to sendMessageSlack for text replies", async () => {
    sendMock.mockResolvedValue(undefined);
    const identity = { username: "Bot", iconEmoji: ":robot:" };
    await deliverReplies(baseParams({ identity }));

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).toMatchObject({ identity });
  });

  it("passes identity to sendMessageSlack for media replies", async () => {
    sendMock.mockResolvedValue(undefined);
    const identity = { username: "Bot", iconUrl: "https://example.com/icon.png" };
    await deliverReplies(
      baseParams({
        identity,
        replies: [{ text: "caption", mediaUrls: ["https://example.com/img.png"] }],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).toMatchObject({ identity });
  });

  it("omits identity key when not provided", async () => {
    sendMock.mockResolvedValue(undefined);
    await deliverReplies(baseParams());

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).not.toHaveProperty("identity");
  });

  it("does not link raw content resolved from DualView symbols after message_sending", async () => {
    sendMock.mockResolvedValue(undefined);
    hookRunnerMock.hasHooks.mockReturnValue(true);
    hookRunnerMock.runMessageSending.mockResolvedValue({ content: "Result: Example title" });

    await deliverReplies(
      baseParams({
        replies: [{ text: "Result: $_DUALVIEW_SYM_web_fetch[a1b2].title" }],
        symbolLinkUrl: "http://127.0.0.1:18789/",
      }),
    );

    expect(sendMock).toHaveBeenCalledWith(
      "C123",
      "Result: <http://127.0.0.1:18789/|[Data] Example title>",
      expect.any(Object),
    );
  });
});

describe("deliverSlackSlashReplies", () => {
  it("does not label unresolved DualView symbols in slash command responses", async () => {
    const respond = vi.fn(async () => undefined);

    await deliverSlackSlashReplies({
      replies: [{ text: "Result: $_DUALVIEW_SYM_web_fetch[a1b2].text" }],
      respond,
      ephemeral: true,
      textLimit: 4000,
      symbolLinkUrl: "http://127.0.0.1:18789/",
    });

    expect(respond).toHaveBeenCalledWith({
      text: "Result: $_DUALVIEW_SYM_web_fetch[a1b2].text",
      response_type: "ephemeral",
    });
  });
});
