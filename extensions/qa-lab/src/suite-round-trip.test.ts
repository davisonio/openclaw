import { buildQaTarget } from "openclaw/plugin-sdk/qa-channel-protocol";
import type { QaBusInboundMessageInput } from "openclaw/plugin-sdk/qa-channel-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runQaSuiteRoundTripProbe, type QaSuiteRoundTripProbe } from "./suite-round-trip.js";

function makeProbe(overrides: Partial<QaSuiteRoundTripProbe> = {}): QaSuiteRoundTripProbe {
  return {
    scenarioId: "channel-canary",
    count: 2,
    maxFailures: 2,
    timeoutMs: 1_000,
    markerPrefix: "QA-RTT",
    input: { conversation: { id: "room", kind: "group" }, senderId: "driver" },
    textPrefix: "Reply exactly: ",
    ...overrides,
  };
}

describe("QA suite round-trip probe", () => {
  let state: ReturnType<typeof createQaBusState>;
  beforeEach(() => {
    state = createQaBusState();
  });
  afterEach(() => state.reset(true));
  const fromScenario = { fromScenario: true, senderId: "primary" } as const;
  const addOutbound = (to: string, text: string, accountId = "sut") =>
    state.addOutboundMessage({ accountId, to, text });

  it.each([
    { id: "telegram-reply-chain-dm", kind: "direct", outboundOnly: false },
    { id: "telegram-command-room", kind: "channel", outboundOnly: false },
    { id: "delivery-dm", kind: "direct", outboundOnly: true },
    { id: "participant-forum", kind: "group", threadId: "42", outboundOnly: false },
  ] as const)(
    "continues the observed $id route without adopting another participant's reply",
    async (route) => {
      const conversation = { id: route.id, kind: route.kind };
      const threadId = "threadId" in route ? route.threadId : undefined;
      const target = buildQaTarget({ chatType: route.kind, conversationId: route.id, threadId });
      addOutbound("group:prior-scenario", "old");
      const scenarioStartCursor = state.getSnapshot().cursor;
      if (!route.outboundOnly) {
        state.addInboundMessage({
          accountId: "sut",
          conversation,
          threadId,
          senderId: "other-participant",
          text: "/status",
          nativeCommand: { name: "status" },
        });
      }
      const priorReply = addOutbound(target, "prior reply");
      const deleted = addOutbound("group:deleted", "deleted");
      state.deleteMessage({ accountId: "sut", messageId: deleted.id });
      addOutbound("group:foreign", "foreign", "foreign");
      const replies: string[] = [];
      const sendInbound = vi.fn(async (input: QaBusInboundMessageInput) => {
        const message = state.addInboundMessage(input);
        const reply = state.addOutboundMessage({
          accountId: "sut",
          to: buildQaTarget({
            chatType: input.conversation.kind,
            conversationId: input.conversation.id,
            threadId: input.threadId,
          }),
          text: input.text,
          replyToId: message.id,
        });
        replies.push(reply.id);
        return message;
      });
      const waitForOutbound = vi.fn(async () => {
        const reply = state
          .getSnapshot()
          .messages.findLast((message) => message.direction === "outbound" && !message.deleted);
        if (!reply) {
          throw new Error("fixture did not record the probe reply");
        }
        return reply;
      });
      const result = await runQaSuiteRoundTripProbe({
        probe: makeProbe({
          scenarioId: "selected-scenario",
          maxFailures: 1,
          input: fromScenario,
          chainReplies: true,
        }),
        transport: { accountId: "sut", state, sendInbound, waitForOutbound },
        scenarioStartCursor,
      });
      expect(result).toMatchObject({ passed: 2, failed: 0 });
      const expectedInput = { accountId: "sut", conversation, threadId, senderId: "primary" };
      expect(sendInbound.mock.calls.map(([input]) => input)).toMatchObject([
        expectedInput,
        { ...expectedInput, replyToId: replies[0] },
      ]);
      const first = sendInbound.mock.calls[0]?.[0];
      expect(first).not.toHaveProperty("replyToId");
      expect(first).not.toHaveProperty("nativeCommand");
      expect(sendInbound.mock.calls.map(([input]) => input.replyToId)).not.toContain(priorReply.id);
      expect(waitForOutbound).toHaveBeenCalledWith(
        expect.objectContaining({ conversation, threadId }),
      );
    },
  );

  it("refuses to reuse a previous scenario route when this attempt has no surviving messages", async () => {
    addOutbound("group:prior", "prior");
    const scenarioStartCursor = state.getSnapshot().cursor;
    const deleted = addOutbound("group:selected", "removed");
    state.deleteMessage({ accountId: "sut", messageId: deleted.id });
    addOutbound("group:foreign", "foreign", "foreign");
    const sendInbound = vi.fn();
    await expect(
      runQaSuiteRoundTripProbe({
        probe: makeProbe({
          scenarioId: "selected-scenario",
          count: 1,
          maxFailures: 1,
          input: fromScenario,
        }),
        transport: { accountId: "sut", state, sendInbound, waitForOutbound: vi.fn() },
        scenarioStartCursor,
      }),
    ).rejects.toThrow("no observed conversation: selected-scenario");
    expect(sendInbound).not.toHaveBeenCalled();
  });

  it("collects requested samples and chains native replies", async () => {
    const messages: Array<{ direction: "outbound"; id: string }> = [];
    const sendInbound = vi.fn().mockResolvedValue({ id: "inbound" });
    const waitForOutbound = vi.fn().mockImplementation(async () => {
      const reply = { id: `out-${messages.length + 1}` };
      messages.push({ direction: "outbound", id: reply.id });
      return reply;
    });

    const result = await runQaSuiteRoundTripProbe({
      probe: makeProbe({ chainReplies: true }),
      transport: {
        state: {
          getSnapshot: () => ({ messages }),
        },
        sendInbound,
        waitForOutbound,
      } as never,
    });

    expect(result).toMatchObject({ passed: 2, failed: 0, timing: { samples: 2 } });
    expect(sendInbound.mock.calls[1]?.[0]).toMatchObject({ replyToId: "out-1" });
  });

  it.each(["timeout", "off-thread reply"])(
    "stops at the failure budget after a %s",
    async (failure) => {
      const result = await runQaSuiteRoundTripProbe({
        probe: makeProbe({ count: 3, maxFailures: 1, timeoutMs: 10 }),
        transport: {
          state: { getSnapshot: () => ({ messages: [] }) },
          sendInbound: vi.fn(),
          waitForOutbound:
            failure === "timeout"
              ? vi.fn().mockRejectedValue(new Error("timeout"))
              : vi.fn().mockResolvedValue({ id: "wrong-thread", threadId: "42" }),
        } as never,
      });

      expect(result).toMatchObject({ passed: 0, failed: 1 });
    },
  );
});
