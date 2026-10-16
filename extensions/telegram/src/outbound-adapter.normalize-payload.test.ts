import {
  adaptMessagePresentationForChannel,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import { describe, expect, it } from "vitest";
import { telegramOutbound } from "./outbound-adapter.js";

type Payload = Parameters<NonNullable<typeof telegramOutbound.normalizePayload>>[0]["payload"];
const normalize = (payload: Payload) => telegramOutbound.normalizePayload?.({ cfg: {}, payload });
const buttons = (...items: MessagePresentationButton[]) => ({
  blocks: [{ type: "buttons" as const, buttons: items }],
});
const genericPresentation = buttons({ label: "Generic", value: "generic" });
const nativeButtons = [[{ text: "Native", callback_data: "native" }]];
const fallbackText = { text: "Pablo Daily Summary", replacesPayloadIndex: 0 };
const reactionPayload = {
  fallbackText,
  channelData: { telegram: { reaction: { emoji: "+1", replyToId: "123" } } },
};
const firstButtons = [[{ text: "Open task 1", callback_data: "one" }]];
const secondButtons = [[{ text: "Open task 2", callback_data: "two" }]];

describe("telegramOutbound normalizePayload", () => {
  it("suppresses metadata-only button payloads when no fallback text exists", () => {
    expect(
      normalize({
        channelData: {
          telegram: { buttons: [[{ text: "Open task", url: "https://example.test/task" }]] },
        },
      }),
    ).toBeNull();
  });

  it("suppresses unrelated metadata-only payloads even when fallback text exists", () => {
    expect(
      normalize({
        fallbackText: { text: "Pablo Daily Summary\n- Review the stuck cron." },
        channelData: { plugin: { traceId: "trace-1" } },
      }),
    ).toBeNull();
  });

  it("merges all fallback adopters into the linked summary and keeps reactions separate", () => {
    const payloads = [
      { text: "Pablo Daily Summary" },
      reactionPayload,
      { fallbackText, channelData: { telegram: { buttons: firstButtons } } },
      { fallbackText, channelData: { telegram: { buttons: secondButtons } } },
    ];
    const normalizedPayloads = payloads.map((payload) => normalize(payload) ?? payload);
    const normalized = telegramOutbound.normalizePayloadBatch?.({
      cfg: {},
      payloads: normalizedPayloads.map((payload, index) => ({ index, payload })),
    });

    expect(normalized).toEqual([
      {
        text: "Pablo Daily Summary",
        fallbackText: { text: "Pablo Daily Summary", replacesPayloadIndex: 0 },
        channelData: {
          telegram: {
            buttons: [
              [{ text: "Open task 1", callback_data: "one" }],
              [{ text: "Open task 2", callback_data: "two" }],
            ],
          },
        },
      },
      {
        fallbackText: { text: "Pablo Daily Summary", replacesPayloadIndex: 0 },
        channelData: { telegram: { reaction: { emoji: "+1", replyToId: "123" } } },
      },
      null,
      null,
    ]);
  });
});

describe("telegramOutbound presentation", () => {
  it("preserves fallback labels after core capability adaptation", async () => {
    const label = "Open the workspace with the complete deployment instructions for production";
    const sourcePresentation = buttons(
      { label: "Continue", action: { type: "command", command: "/continue" } },
      { label, action: { type: "web-app", url: "https://example.com/app" } },
    );
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: { presentationTextMode: "fallback" },
      presentation: adaptMessagePresentationForChannel({
        presentation: sourcePresentation,
        capabilities: telegramOutbound.presentationCapabilities,
      }),
      sourcePresentation,
      ctx: { cfg: {}, to: "-10012345" } as never,
    });

    expect(rendered?.text).toContain(label);
    expect(rendered?.text).toContain("https://example.com/app");
    expect(rendered?.channelData?.telegram).toEqual({
      buttons: [[{ text: "Continue", callback_data: "tgcmd:/continue" }]],
    });
  });

  it("preserves explicit Telegram buttons when rendering presentation payloads", async () => {
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: {
        text: "Use native buttons:",
        channelData: { telegram: { buttons: nativeButtons } },
      },
      presentation: genericPresentation,
      ctx: { cfg: {} } as never,
    });

    expect(rendered?.channelData?.telegram).toMatchObject({
      buttons: [[{ text: "Native", callback_data: "native" }]],
    });
    expect(rendered?.text).toBe("Use native buttons:\n\n- Generic");
  });

  it("preserves legacy interactive buttons when rendering mixed presentation payloads", async () => {
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: {
        text: "Choose:",
        interactive: buttons({ label: "Legacy", value: "legacy" }),
      },
      presentation: genericPresentation,
      ctx: { cfg: {} } as never,
    });
    expect(rendered?.channelData?.telegram).toMatchObject({
      buttons: [[{ text: "Legacy", callback_data: "legacy" }]],
    });

    expect(rendered?.text).toBe("Choose:\n\n- Generic");
  });
});

describe("telegramOutbound.sanitizeText", () => {
  const islandText =
    'before <details><summary>More</summary>body</details> <tg-math-block>x^2</tg-math-block> <ul><li><input type="checkbox" checked/>done</li></ul>';
  type SanitizeOptions = Parameters<NonNullable<typeof telegramOutbound.sanitizeText>>[0];
  const sanitize = (cfg: SanitizeOptions["cfg"], accountId?: string) =>
    telegramOutbound.sanitizeText?.({
      text: islandText,
      payload: { text: islandText },
      cfg,
      accountId,
    });
  const preservesDetails = (telegram: { richMessages?: boolean }) =>
    telegramOutbound.preserveMarkdownDetails?.({
      cfg: { channels: { telegram } },
      accountId: "default",
    });

  it("converts HTML to plain markers for non-rich accounts", () => {
    const sanitized = sanitize({ channels: { telegram: {} } }, "default");
    expect(sanitized).not.toContain("<details>");
    expect(sanitized).toContain("**More**\n\nbody");
    expect(sanitized).toContain("• done");
  });

  it("resolves the effective named default account when accountId is omitted", () => {
    const accounts = { "rich-bot": { richMessages: true } };
    const sanitized = sanitize({
      channels: { telegram: { defaultAccount: "rich-bot", accounts } },
    });
    expect(sanitized).toContain("<details><summary>More</summary>");
    expect(sanitized).toContain("<tg-math-block>x^2</tg-math-block>");
    expect(sanitized).toContain('<input type="checkbox" checked/>');
  });

  it("advertises native details preservation only for rich accounts", () => {
    expect(preservesDetails({ richMessages: true })).toBe(true);
    expect(preservesDetails({})).toBe(false);
  });
});
