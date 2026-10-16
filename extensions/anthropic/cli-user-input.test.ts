import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { describe, expect, it, vi } from "vitest";
import { createClaudeCliUserInputAuthorizer } from "./cli-user-input.js";

function authorizerFor(requestUserInput: CliBackendExecuteContext["requestUserInput"]) {
  return createClaudeCliUserInputAuthorizer({
    command: "/usr/local/bin/claude",
    args: [],
    cwd: "/tmp",
    env: {},
    prompt: "test",
    modelId: "claude-sonnet-4-6",
    systemPrompt: "test",
    useResume: false,
    timeoutMs: 30_000,
    requestToolPermission: async () => ({ behavior: "allow", updatedInput: {} }),
    requestUserInput,
  });
}

const options = (...labels: string[]) =>
  labels.map((label) => ({ label, description: "Use " + label }));
const validOptions = options("A", "B");
const question = (overrides: Record<string, unknown> = {}) => ({
  header: "Stack",
  question: "Q?",
  options: validOptions,
  multiSelect: false,
  ...overrides,
});
const malformed = (overrides: Record<string, unknown>) => ({ questions: [question(overrides)] });
const mappedAnswers = (proof: string) => ({ "Runner?": "Vitest", "Proof?": proof });
const answered = (...proof: string[]) =>
  vi.fn<CliBackendExecuteContext["requestUserInput"]>(async () => ({
    status: "answered",
    answers: { question_1: ["Vitest"], question_2: proof },
  }));
const input = {
  questions: [
    question({ question: "Runner?", options: options("Vitest", "Node test") }),
    question({
      header: "Proof",
      question: "Proof?",
      options: options("Unit tests", "UI proof"),
      multiSelect: true,
    }),
  ],
};

describe("Claude CLI user input adapter", () => {
  it("maps Claude questions and answers while deduplicating the CLI callbacks", async () => {
    const requestUserInput = answered("Unit tests", "UI proof");
    const authorizer = authorizerFor(requestUserInput);
    const signal = new AbortController().signal;

    const first = authorizer.authorize({ input, signal, toolUseId: "claude-question-1" });
    const second = authorizer.authorize({ input, signal, toolUseId: "claude-question-1" });

    await expect(first).resolves.toEqual({
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: mappedAnswers("Unit tests, UI proof"),
      },
    });
    await expect(second).resolves.toEqual(await first);
    expect(requestUserInput).toHaveBeenCalledOnce();
    expect(requestUserInput).toHaveBeenCalledWith({
      toolName: "AskUserQuestion",
      intro: "Claude needs input:",
      toolCallId: "claude-question-1",
      abortSignal: signal,
      questions: [
        { ...input.questions[0], id: "question_1", isOther: true },
        { ...input.questions[1], id: "question_2", isOther: true },
      ],
    });
  });

  it("returns actionable denial guidance when the operator skips", async () => {
    const authorizer = authorizerFor(async () => ({
      status: "cancelled",
      message: "The operator skipped this question.",
    }));

    await expect(
      authorizer.authorize({ input, signal: new AbortController().signal }),
    ).resolves.toEqual({
      behavior: "deny",
      message: "The operator skipped this question. Continue with your best judgment.",
    });
  });

  it("guides a malformed question retry without replaying the rejected call", async () => {
    const requestUserInput = answered("Unit tests");
    const authorizer = createClaudeCliUserInputAuthorizer(createContext(requestUserInput));
    const signal = new AbortController().signal;
    const rejected = {
      behavior: "deny",
      message:
        "OpenClaw rejected malformed Claude user questions: questions[0].header must be at most 12 characters. Correct the invalid field and retry AskUserQuestion.",
    };

    await expect(
      authorizer.authorize({
        input: { questions: [{ ...input.questions[0], header: "Too long for Claude" }] },
        signal,
        toolUseId: "rejected-question",
      }),
    ).resolves.toEqual(rejected);
    await expect(
      authorizer.authorize({ input, signal, toolUseId: "rejected-question" }),
    ).resolves.toEqual(rejected);
    expect(requestUserInput).not.toHaveBeenCalled();

    await expect(
      authorizer.authorize({ input, signal, toolUseId: "corrected-question" }),
    ).resolves.toMatchObject({
      behavior: "allow",
      updatedInput: { answers: mappedAnswers("Unit tests") },
    });
    expect(requestUserInput).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing questions array", {}, "questions must be an array of 1 to 4 questions"],
    [
      "too many questions",
      { questions: ["A", "B", "C", "D", "E"].map((header) => question({ header })) },
      "questions must be an array of 1 to 4 questions",
    ],
    [
      "non-boolean multiSelect",
      malformed({ multiSelect: "no" }),
      "questions[0].multiSelect must be a boolean",
    ],
    [
      "too few options",
      malformed({ options: options("A") }),
      "questions[0].options must be an array of 2 to 4 options",
    ],
    [
      "empty option description",
      malformed({ options: [...options("A"), { label: "B", description: "" }] }),
      "questions[0].options[1].description must not be empty",
    ],
    [
      "missing option label",
      malformed({ options: validOptions.map(({ description }) => ({ description })) }),
      "questions[0].options[0].label must be a string",
    ],
    ["non-record question", { questions: ["not a question"] }, "questions[0] must be an object"],
  ])(
    "reports the failed constraint for %s without echoing payload text",
    async (_case, malformedInput, expectedDetail) => {
      const requestUserInput = vi.fn();
      const authorizer = createClaudeCliUserInputAuthorizer(createContext(requestUserInput));

      const result = await authorizer.authorize({
        input: malformedInput as Record<string, unknown>,
        signal: new AbortController().signal,
      });

      expect(result).toEqual({
        behavior: "deny",
        message: `OpenClaw rejected malformed Claude user questions: ${expectedDetail}. Correct the invalid field and retry AskUserQuestion.`,
      });
      expect(requestUserInput).not.toHaveBeenCalled();
    },
  );
});
