import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { createSlackSendTestClient, installSlackBlockTestMocks } from "./blocks.test-helpers.js";

installSlackBlockTestMocks();
const runOutboundMessageHook = vi.fn(
  async (params: { content: string }): Promise<{ content: string } | null> => ({
    content: params.content,
  }),
);

vi.mock("../plugins/outbound-hook.js", () => ({
  runOutboundMessageHook: (...args: unknown[]) =>
    runOutboundMessageHook(...(args as [params: { content: string }])),
}));

const { sendMessageSlack } = await import("./send.js");

function createStateDirWithSlackSession(channelId: string, sessionId: string): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-links-"));
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      [`agent:main:slack:channel:${channelId.toLowerCase()}`]: { sessionId },
    }),
    "utf8",
  );
  return stateDir;
}

describe("sendMessageSlack NO_REPLY guard", () => {
  beforeEach(() => {
    runOutboundMessageHook.mockClear();
    runOutboundMessageHook.mockImplementation(async (params: { content: string }) => ({
      content: params.content,
    }));
  });

  it("suppresses NO_REPLY text before any Slack API call", async () => {
    const client = createSlackSendTestClient();
    const result = await sendMessageSlack("channel:C123", "NO_REPLY", {
      token: "xoxb-test",
      client,
    });

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(result.messageId).toBe("suppressed");
  });

  it("suppresses NO_REPLY with surrounding whitespace", async () => {
    const client = createSlackSendTestClient();
    const result = await sendMessageSlack("channel:C123", "  NO_REPLY  ", {
      token: "xoxb-test",
      client,
    });

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(result.messageId).toBe("suppressed");
  });

  it("does not suppress substantive text containing NO_REPLY", async () => {
    const client = createSlackSendTestClient();
    await sendMessageSlack("channel:C123", "This is not a NO_REPLY situation", {
      token: "xoxb-test",
      client,
    });

    expect(client.chat.postMessage).toHaveBeenCalled();
  });

  it("does not label unresolved DualView symbol placeholders", async () => {
    await withEnvAsync({ DUALVIEW_DASHBOARD_URL: "http://127.0.0.1:3456/bot/" }, async () => {
      const client = createSlackSendTestClient();
      await sendMessageSlack("channel:C123", "Result: $_DUALVIEW_SYM_web_fetch[a1b2].text", {
        token: "xoxb-test",
        client,
      });

      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Result: $_DUALVIEW_SYM_web_fetch[a1b2].text",
        }),
      );
    });
  });

  it("does not label unresolved DualView symbol placeholders for the current Slack bot session", async () => {
    const stateDir = createStateDirWithSlackSession("C123", "b739f3c2-2896-4cd6-9692-44a3379943a2");
    try {
      await withEnvAsync(
        {
          DUALVIEW_DASHBOARD_URL: "http://localhost:13457/bot/",
          DUALVIEW_BOT_BATCH_ID: "20260628_125215",
          OPENCLAW_STATE_DIR: stateDir,
        },
        async () => {
          const client = createSlackSendTestClient();
          await sendMessageSlack("channel:C123", "Result: $_DUALVIEW_SYM_web_fetch[a1b2].text", {
            token: "xoxb-test",
            client,
          });

          expect(client.chat.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
              text: "Result: $_DUALVIEW_SYM_web_fetch[a1b2].text",
            }),
          );
        },
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not label unresolved DualView symbol placeholders inside Slack mrkdwn blocks", async () => {
    await withEnvAsync({ DUALVIEW_DASHBOARD_URL: "http://127.0.0.1:3456/bot/" }, async () => {
      const client = createSlackSendTestClient();
      await sendMessageSlack("channel:C123", "", {
        token: "xoxb-test",
        client,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "Result: $_DUALVIEW_SYM_web_fetch[a1b2].text" },
          },
        ],
      });

      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Result: $_DUALVIEW_SYM_web_fetch[a1b2].text",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "Result: $_DUALVIEW_SYM_web_fetch[a1b2].text",
              },
            },
          ],
        }),
      );
    });
  });

  it("does not label unresolved Slack block text when caller already applied hooks", async () => {
    await withEnvAsync({ DUALVIEW_DASHBOARD_URL: "http://127.0.0.1:3456/bot/" }, async () => {
      const client = createSlackSendTestClient();
      await sendMessageSlack("channel:C123", "", {
        token: "xoxb-test",
        client,
        skipMessageSendingHook: true,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "Result: $_DUALVIEW_SYM_web_fetch[a1b2].text" },
          },
        ],
      });

      expect(runOutboundMessageHook).not.toHaveBeenCalled();
      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Result: $_DUALVIEW_SYM_web_fetch[a1b2].text",
        }),
      );
    });
  });

  it("runs message_sending hook before direct Slack sends", async () => {
    await withEnvAsync({ DUALVIEW_DASHBOARD_URL: "http://127.0.0.1:3456/bot/" }, async () => {
      runOutboundMessageHook.mockResolvedValueOnce({ content: "Result: Example title" });
      const client = createSlackSendTestClient();

      await sendMessageSlack("channel:C123", "Result: $_DUALVIEW_SYM_web_fetch[a1b2].title", {
        token: "xoxb-test",
        client,
      });

      expect(runOutboundMessageHook).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "C123",
          content: "Result: $_DUALVIEW_SYM_web_fetch[a1b2].title",
          channel: "slack",
          accountId: "default",
        }),
      );
      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Result: <http://127.0.0.1:3456/bot/|[Data] Example title>",
        }),
      );
    });
  });

  it("does not link multiline resolved content with Gmail IDs", async () => {
    const stateDir = createStateDirWithSlackSession("C123", "a12cd2ef-5b25-42bb-b84d-217ba951c8b3");
    try {
      await withEnvAsync(
        {
          DUALVIEW_DASHBOARD_URL: "https://compsec.snu.ac.kr/adfi-test/bot/",
          DUALVIEW_BOT_BATCH_ID: "20260629_034635",
          OPENCLAW_STATE_DIR: stateDir,
        },
        async () => {
          runOutboundMessageHook.mockResolvedValueOnce({
            content:
              "• Reply needed\n" +
              "  - Supporting documents needed for completed LLM API purchase (<5Ry6VyZ-NnmBpLHR@example.com>) — Minji asked you to send the payment receipt.",
          });
          const client = createSlackSendTestClient();

          await sendMessageSlack(
            "channel:C123",
            "$_DUALVIEW_SYM_exec[3268].snippet.triage_report",
            {
              token: "xoxb-test",
              client,
            },
          );

          const payload = client.chat.postMessage.mock.calls[0]?.[0] as { text?: string };
          expect(payload.text).toContain("• Reply needed");
          expect(payload.text).toContain("• Supporting documents needed");
          expect(payload.text).toContain("&lt;5Ry6VyZ-NnmBpLHR@example.com&gt;");
          expect(payload.text).toContain(
            "symbol/%24_DUALVIEW_SYM_exec%5B3268%5D.snippet.triage_report|[Data begins]>",
          );
          expect(payload.text).toContain(
            "symbol/%24_DUALVIEW_SYM_exec%5B3268%5D.snippet.triage_report|[Data ends]>",
          );
          expect(payload.text).not.toContain("%7C  - Supporting documents needed");
          expect(payload.text).not.toContain("(<5Ry6VyZ-NnmBpLHR@example.com>)");
        },
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("skips message_sending hook when caller already applied it", async () => {
    await withEnvAsync({ DUALVIEW_DASHBOARD_URL: "http://127.0.0.1:3456/bot/" }, async () => {
      const client = createSlackSendTestClient();

      await sendMessageSlack("channel:C123", "Result: $_DUALVIEW_SYM_web_fetch[a1b2].title", {
        token: "xoxb-test",
        client,
        skipMessageSendingHook: true,
      });

      expect(runOutboundMessageHook).not.toHaveBeenCalled();
      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Result: $_DUALVIEW_SYM_web_fetch[a1b2].title",
        }),
      );
    });
  });

  it("does not send when message_sending hook cancels", async () => {
    runOutboundMessageHook.mockResolvedValueOnce(null);
    const client = createSlackSendTestClient();

    const result = await sendMessageSlack("channel:C123", "hello", {
      token: "xoxb-test",
      client,
    });

    expect(client.chat.postMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ messageId: "cancelled-by-hook", channelId: "C123" });
  });

  it("does not suppress NO_REPLY when blocks are attached", async () => {
    const client = createSlackSendTestClient();
    const result = await sendMessageSlack("channel:C123", "NO_REPLY", {
      token: "xoxb-test",
      client,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "content" } }],
    });

    expect(client.chat.postMessage).toHaveBeenCalled();
    expect(result.messageId).toBe("171234.567");
  });
});

describe("sendMessageSlack blocks", () => {
  it("posts blocks with fallback text when message is empty", async () => {
    const client = createSlackSendTestClient();
    const result = await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      client,
      blocks: [{ type: "divider" }],
    });

    expect(client.conversations.open).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        text: "Shared a Block Kit message",
        blocks: [{ type: "divider" }],
      }),
    );
    expect(result).toEqual({ messageId: "171234.567", channelId: "C123" });
  });

  it("derives fallback text from image blocks", async () => {
    const client = createSlackSendTestClient();
    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      client,
      blocks: [{ type: "image", image_url: "https://example.com/a.png", alt_text: "Build chart" }],
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Build chart",
      }),
    );
  });

  it("derives fallback text from video blocks", async () => {
    const client = createSlackSendTestClient();
    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      client,
      blocks: [
        {
          type: "video",
          title: { type: "plain_text", text: "Release demo" },
          video_url: "https://example.com/demo.mp4",
          thumbnail_url: "https://example.com/thumb.jpg",
          alt_text: "demo",
        },
      ],
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Release demo",
      }),
    );
  });

  it("derives fallback text from file blocks", async () => {
    const client = createSlackSendTestClient();
    await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      client,
      blocks: [{ type: "file", source: "remote", external_id: "F123" }],
    });

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Shared a file",
      }),
    );
  });

  it("rejects blocks combined with mediaUrl", async () => {
    const client = createSlackSendTestClient();
    await expect(
      sendMessageSlack("channel:C123", "hi", {
        token: "xoxb-test",
        client,
        mediaUrl: "https://example.com/image.png",
        blocks: [{ type: "divider" }],
      }),
    ).rejects.toThrow(/does not support blocks with mediaUrl/i);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("rejects empty blocks arrays from runtime callers", async () => {
    const client = createSlackSendTestClient();
    await expect(
      sendMessageSlack("channel:C123", "hi", {
        token: "xoxb-test",
        client,
        blocks: [],
      }),
    ).rejects.toThrow(/must contain at least one block/i);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("rejects blocks arrays above Slack max count", async () => {
    const client = createSlackSendTestClient();
    const blocks = Array.from({ length: 51 }, () => ({ type: "divider" }));
    await expect(
      sendMessageSlack("channel:C123", "hi", {
        token: "xoxb-test",
        client,
        blocks,
      }),
    ).rejects.toThrow(/cannot exceed 50 items/i);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("rejects blocks missing type from runtime callers", async () => {
    const client = createSlackSendTestClient();
    await expect(
      sendMessageSlack("channel:C123", "hi", {
        token: "xoxb-test",
        client,
        blocks: [{} as { type: string }],
      }),
    ).rejects.toThrow(/non-empty string type/i);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
});
