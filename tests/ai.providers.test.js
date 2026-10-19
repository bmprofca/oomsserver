import test from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { ApiError } from "@google/genai";
import { runChat } from "../ai/orchestrator.js";
import { createMcpForRequest } from "../ai/mcp/createMcpForRequest.js";
import { createOpenAIProvider, mapOpenAIError } from "../ai/providers/openai.js";
import { createDeepSeekProvider } from "../ai/providers/deepseek.js";
import { createGeminiProvider, mapGeminiError } from "../ai/providers/gemini.js";
import { createProvider } from "../ai/providers/index.js";
import { AI_PROVIDER_CATALOG } from "../ai/providers/catalog.js";
import { foldHistoryIntoQuestion, parseToolArguments } from "../ai/providers/translate.js";
import { createFakeDb, makeCtx, TEST_CONFIG } from "./helpers/aiFakes.js";

/**
 * Each adapter runs through the real orchestrator + MCP tools against a fake SDK client,
 * so translation both ways (tools, tool calls, tool results, replayed reasoning) is covered
 * without network access.
 */

function staffDb() {
    return createFakeDb([
        [/FROM branch_mapping bm\s+LEFT JOIN profile/, () => [{ username: "arun", type: "staff", name: "Arun Pawan", designation: "Accountant" }]],
    ]);
}

const clone = (v) => JSON.parse(JSON.stringify(v));

async function runWith(provider, history = []) {
    const ctx = makeCtx({ username: "boss", permissions: ["staff_view_manage"] });
    const mcp = await createMcpForRequest(ctx, { db: staffDb() }, { timeoutMs: 1000 });
    try {
        return await runChat({ provider, mcpClient: mcp.client, system: "SYS", history, userMessage: "Who is Arun?", config: TEST_CONFIG });
    } finally {
        await mcp.close();
    }
}

test("OpenAI adapter: Responses API tool loop replays reasoning items and returns function outputs", async () => {
    const calls = [];
    const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENC" };
    const fnCall = { type: "function_call", id: "fc_1", call_id: "call_1", name: "search_staff", arguments: '{"search":"Arun"}', status: "completed" };
    const responses = [
        { status: "completed", output: [reasoning, fnCall], usage: { input_tokens: 100, output_tokens: 20 } },
        {
            status: "completed",
            output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Arun Pawan is an Accountant.", annotations: [] }] }],
            usage: { input_tokens: 150, output_tokens: 10 },
        },
    ];
    const client = { responses: { create: async (params) => { calls.push(clone(params)); return responses[calls.length - 1]; } } };
    const provider = createOpenAIProvider({ apiKey: "sk-test", model: "gpt-6.1-sol", effort: "low", client });

    const result = await runWith(provider, [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello!" }]);

    assert.equal(result.text, "Arun Pawan is an Accountant.");
    assert.deepEqual(result.toolCalls.map((c) => [c.name, c.ok]), [["search_staff", true]]);
    assert.deepEqual(result.usage, { input_tokens: 250, output_tokens: 30 });

    const first = calls[0];
    assert.equal(first.instructions, "SYS");
    assert.equal(first.store, false);
    assert.deepEqual(first.include, ["reasoning.encrypted_content"]);
    assert.deepEqual(first.reasoning, { effort: "low" });
    assert.equal(first.tool_choice, "auto");
    const tool = first.tools.find((t) => t.name === "search_staff");
    assert.equal(tool.type, "function");
    assert.equal(tool.parameters.type, "object");
    assert.deepEqual(first.input.slice(0, 2), [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello!" }]);

    const second = calls[1].input;
    assert.ok(second.some((i) => i.type === "reasoning" && i.encrypted_content === "ENC"), "encrypted reasoning replayed");
    assert.ok(second.some((i) => i.type === "function_call" && i.call_id === "call_1"));
    const out = second.find((i) => i.type === "function_call_output");
    assert.equal(out.call_id, "call_1");
    assert.match(out.output, /Arun Pawan/);
    assert.ok(!JSON.stringify(calls).includes('"vendor"'), "internal vendor blocks never sent");
});

test("OpenAI adapter: last round disables tools; refusal and truncation are mapped", async () => {
    const calls = [];
    const client = {
        responses: {
            create: async (params) => {
                calls.push(params);
                return { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: {} };
            },
        },
    };
    const provider = createOpenAIProvider({ apiKey: "sk-test", model: "m", client });
    const r = await provider.createMessage({ system: "s", messages: [{ role: "user", content: "x" }], tools: [{ name: "t", description: "d", input_schema: { type: "object" } }], maxTokens: 10, disableTools: true });
    assert.equal(calls[0].tool_choice, "none");
    assert.equal(r.stop_reason, "max_tokens");

    client.responses.create = async () => ({
        status: "completed",
        output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
        usage: {},
    });
    assert.equal((await provider.createMessage({ system: "s", messages: [{ role: "user", content: "x" }], tools: [], maxTokens: 10 })).stop_reason, "refusal");
});

test("DeepSeek adapter: replays reasoning_content within a question and folds earlier turns", async () => {
    const calls = [];
    const completions = [
        {
            choices: [{
                finish_reason: "tool_calls",
                message: {
                    role: "assistant",
                    content: "",
                    reasoning_content: "I should look up Arun.",
                    tool_calls: [{ id: "call_9", type: "function", function: { name: "search_staff", arguments: '{"search":"Arun"}' } }],
                },
            }],
            usage: { prompt_tokens: 50, completion_tokens: 12 },
        },
        { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Arun is an Accountant.", reasoning_content: "Done." } }], usage: { prompt_tokens: 80, completion_tokens: 6 } },
    ];
    const client = { chat: { completions: { create: async (params) => { calls.push(clone(params)); return completions[calls.length - 1]; } } } };
    const provider = createDeepSeekProvider({ apiKey: "sk-test", model: "deepseek-flash", effort: "high", client });

    const result = await runWith(provider, [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello!" }]);
    assert.equal(result.text, "Arun is an Accountant.");
    assert.deepEqual(result.usage, { input_tokens: 130, output_tokens: 18 });

    const first = calls[0];
    assert.equal(first.reasoning_effort, "high");
    assert.deepEqual(first.messages[0], { role: "system", content: "SYS" });
    assert.equal(first.messages.length, 2, "earlier turns folded into the question (no assistant turn without reasoning_content)");
    assert.match(first.messages[1].content, /Assistant: Hello![\s\S]*Current question:\nWho is Arun\?/);
    assert.equal(first.tools[0].type, "function");
    assert.ok(first.tools.some((t) => t.function.name === "search_staff"));

    const second = calls[1].messages;
    const assistant = second.find((m) => m.role === "assistant");
    assert.equal(assistant.reasoning_content, "I should look up Arun.", "reasoning_content passed back");
    assert.equal(assistant.tool_calls[0].id, "call_9");
    const toolMsg = second.find((m) => m.role === "tool");
    assert.equal(toolMsg.tool_call_id, "call_9");
    assert.match(toolMsg.content, /Arun Pawan/);
});

test("DeepSeek verify checks the model is listed", async () => {
    const client = { models: { list: async () => ({ data: [{ id: "deepseek-flash" }] }) } };
    assert.equal(await createDeepSeekProvider({ apiKey: "k", model: "deepseek-flash", client }).verify(), true);
    await assert.rejects(createDeepSeekProvider({ apiKey: "k", model: "nope", client }).verify(), { code: "MODEL_UNAVAILABLE" });
});

test("Gemini adapter: replays model content (thought signatures) and sends functionResponse parts", async () => {
    const calls = [];
    const modelContent = {
        role: "model",
        parts: [{ functionCall: { id: "fc-7", name: "search_staff", args: { search: "Arun" } }, thoughtSignature: "SIG123" }],
    };
    const responses = [
        { candidates: [{ content: modelContent, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 5, thoughtsTokenCount: 15 } },
        { candidates: [{ content: { role: "model", parts: [{ text: "Arun is an Accountant." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 7 } },
    ];
    const client = { models: { generateContent: async (req) => { calls.push(clone(req)); return responses[calls.length - 1]; } } };
    const provider = createGeminiProvider({ apiKey: "AIza-test", model: "gemini-3.8-flash", effort: "medium", client });

    const result = await runWith(provider, [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello!" }]);
    assert.equal(result.text, "Arun is an Accountant.");
    assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 27 });

    const first = calls[0];
    assert.equal(first.model, "gemini-3.8-flash");
    assert.equal(first.config.systemInstruction, "SYS");
    assert.deepEqual(first.config.thinkingConfig, { thinkingLevel: "MEDIUM" });
    assert.equal(first.config.toolConfig.functionCallingConfig.mode, "AUTO");
    assert.ok(first.config.tools[0].functionDeclarations.some((f) => f.name === "search_staff" && f.parametersJsonSchema.type === "object"));
    assert.deepEqual(first.contents.slice(0, 2), [{ role: "user", parts: [{ text: "hi" }] }, { role: "model", parts: [{ text: "Hello!" }] }]);

    const second = calls[1].contents;
    const replay = second.find((c) => c.role === "model" && c.parts[0].functionCall);
    assert.equal(replay.parts[0].thoughtSignature, "SIG123", "thought signature preserved");
    const fr = second.at(-1).parts[0].functionResponse;
    assert.equal(fr.id, "fc-7");
    assert.equal(fr.name, "search_staff");
    assert.ok(fr.response.output, "tool output sent as object");
});

test("Gemini adapter: call ids it did not issue are not echoed; safety blocks map to refusal", async () => {
    const calls = [];
    const responses = [
        { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "search_staff", args: { search: "Arun" } } }] }, finishReason: "STOP" }] },
        { candidates: [{ content: { role: "model", parts: [] }, finishReason: "SAFETY" }] },
    ];
    const client = { models: { generateContent: async (req) => { calls.push(clone(req)); return responses[calls.length - 1]; } } };
    const result = await runWith(createGeminiProvider({ apiKey: "k", model: "gemini-3.8-flash", client }));
    assert.equal(result.status, "refusal");
    const fr = calls[1].contents.at(-1).parts[0].functionResponse;
    assert.equal(fr.id, undefined);
    assert.equal(fr.name, "search_staff");

    // Older 2.x models get no thinkingLevel.
    const old = createGeminiProvider({ apiKey: "k", model: "gemini-2.5-flash", client: { models: { generateContent: async (req) => { calls.push(clone(req)); return { candidates: [] }; } } } });
    await old.createMessage({ system: "s", messages: [{ role: "user", content: "x" }], tools: [], maxTokens: 5 });
    assert.equal(calls.at(-1).config.thinkingConfig, undefined);
});

test("errors from each SDK map to provider-neutral codes", () => {
    const headers = new Headers();
    assert.equal(mapOpenAIError(new OpenAI.AuthenticationError(401, {}, "bad key", headers)).code, "INVALID_KEY");
    assert.equal(mapOpenAIError(new OpenAI.RateLimitError(429, { message: "Rate limit reached" }, undefined, headers)).code, "RATE_LIMITED");
    assert.equal(mapOpenAIError(new OpenAI.RateLimitError(429, { message: "You exceeded your current quota" }, undefined, headers)).code, "BILLING");
    assert.equal(mapOpenAIError(new OpenAI.NotFoundError(404, {}, "model not found", headers)).code, "MODEL_UNAVAILABLE");
    assert.equal(mapOpenAIError(OpenAI.APIError.generate(402, { message: "Insufficient Balance" }, undefined, headers)).code, "BILLING");
    assert.equal(mapOpenAIError(OpenAI.APIError.generate(503, {}, "down", headers)).code, "UNAVAILABLE");

    assert.equal(mapGeminiError(new ApiError({ message: "Billing is not enabled for this project", status: 400 })).code, "BILLING");
    assert.equal(mapGeminiError(new ApiError({ message: "API key not valid. Please pass a valid API key.", status: 400 })).code, "INVALID_KEY");
    assert.equal(mapGeminiError(new ApiError({ message: "models/x is not found", status: 404 })).code, "MODEL_UNAVAILABLE");
    assert.equal(mapGeminiError(new ApiError({ message: "Resource exhausted", status: 429 })).code, "RATE_LIMITED");
    assert.equal(mapGeminiError(new ApiError({ message: "Invalid argument", status: 400 })).code, "BAD_REQUEST");
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    assert.equal(mapGeminiError(abort, { aborted: true }).code, "ABORTED");
    assert.equal(mapGeminiError(abort, { aborted: false }).code, "TIMEOUT");
});

test("factory builds every catalog provider; unknown providers and missing keys are refused", () => {
    for (const p of AI_PROVIDER_CATALOG) {
        const provider = createProvider({ provider: p.id, apiKey: "test-key", model: p.defaultModel, effort: "medium" });
        assert.equal(provider.name, p.id);
        assert.equal(typeof provider.createMessage, "function");
        assert.equal(typeof provider.verify, "function");
        assert.ok(p.models.some((m) => m.id === p.defaultModel));
    }
    assert.throws(() => createProvider({ provider: "mystery", apiKey: "k", model: "m" }), { code: "NOT_CONFIGURED" });
    assert.throws(() => createProvider({ provider: "openai", apiKey: "", model: "m" }), { code: "NOT_CONFIGURED" });
});

test("translation helpers", () => {
    assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
    assert.deepEqual(parseToolArguments("not json"), { _invalid_arguments: true });
    assert.deepEqual(parseToolArguments("[1]"), { _invalid_arguments: true });
    assert.deepEqual(parseToolArguments(""), {});
    const only = [{ role: "user", content: "q" }];
    assert.equal(foldHistoryIntoQuestion(only), only);
});

test("Anthropic 'credit balance is too low' maps to BILLING, other 400s stay BAD_REQUEST", async () => {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const { createAnthropicProvider } = await import("../ai/providers/anthropic.js");
    const sdkError = (message) => new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message } }, undefined, new Headers());
    const providerThrowing = (error) => createAnthropicProvider({
        apiKey: "sk-ant-x",
        model: "claude-sonnet-5-5",
        client: { beta: { messages: { create: async () => { throw error; } } } },
    });
    const req = { system: "s", messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 16 };
    await assert.rejects(
        providerThrowing(sdkError("Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.")).createMessage(req),
        { code: "BILLING" }
    );
    await assert.rejects(providerThrowing(sdkError("messages.0.content: Field required")).createMessage(req), { code: "BAD_REQUEST" });
});
