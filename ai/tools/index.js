import * as z from "zod";
import { clarificationBlock } from "../blocks.js";
import staffTools from "./staff.js";
import taskTools from "./tasks.js";
import attendanceTools from "./attendance.js";
import financeTools from "./finance.js";
import reportTools from "./reports.js";
import actionTools from "./actions.js";

/**
 * ask_clarification — the model calls this when the user's request is ambiguous
 * (several people with the same name, a person with more than one account, an unclear period).
 * The orchestrator ends the turn after it and shows the options as clickable chips.
 */
export const askClarification = {
    name: "ask_clarification",
    description:
        "Ask the user ONE short clarifying question when the request is ambiguous (e.g. several matching people or " +
        "accounts, or an unclear period). Provide the concrete choices found in tool results as options. " +
        "Do not use it when the request is already clear.",
    input: z.object({
        question: z.string().trim().min(3).max(300),
        options: z.array(z.string().trim().min(1).max(120)).max(8).default([]),
    }).strict(),
    allowed: () => true,
    terminal: true,
    async handler(_ctx, args) {
        return {
            data: { asked: true },
            blocks: [clarificationBlock(args)],
        };
    },
};

/**
 * Every registered OOMS tool. Read tools are always available (per permission). Write tools
 * (tool.write) only PREPARE actions that a person confirms, and are only registered when the
 * context is in read-write mode — see tools/actions.js.
 */
export const ALL_TOOLS = [
    ...staffTools,
    ...taskTools,
    ...attendanceTools,
    ...financeTools,
    ...reportTools,
    ...actionTools,
    askClarification,
];

export function toolsForContext(ctx) {
    return ALL_TOOLS.filter((t) => t.allowed(ctx));
}
