import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { after, test } from "node:test"

// Expose private seams from an isolated copy, without adding production exports.
// The smoke suite covers the fetch/ACP/MCP path; these cases cover batched
// client payloads that the sequential fake ACP server cannot emit itself.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-compat-test-"))
const entry = new URL("./index.mjs", import.meta.url)
let source = fs.readFileSync(entry, "utf8")
source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, target) => `from ${JSON.stringify(new URL(target, entry).href)}`)
fs.writeFileSync(path.join(workspace, "bridge.mjs"), source + "\nexport { inspectToolTurn, canReplayFollowUpAfterResults, matchToolResults, historyKey, allProcs, toolCalls, renderInitialPromptParts, withStateLock, Turn, translateUsage, conversationKey, instructionsKey, extractDynamicSystemBlocks, MAGPIE_PLACEHOLDER_NOTICE, normalizeTools, toolResult, blockText, readStepTranscriptUsage, bridgeGeminiDir, compactSkillsInstructions, sessionInstructions, normalizeApplyPatchArgs };\n")
const { inspectToolTurn, canReplayFollowUpAfterResults, matchToolResults, historyKey, allProcs, toolCalls, renderInitialPromptParts, withStateLock, Turn, translateUsage, conversationKey, instructionsKey, extractDynamicSystemBlocks, MAGPIE_PLACEHOLDER_NOTICE, normalizeTools, toolResult, blockText, readStepTranscriptUsage, bridgeGeminiDir, compactSkillsInstructions, sessionInstructions, normalizeApplyPatchArgs, AntigravityBridgePlugin } = await import(pathToFileURL(path.join(workspace, "bridge.mjs")).href)
after(() => fs.rmSync(workspace, { recursive: true, force: true }))

const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2VB" } }
const result = (id, name, text) => ({
  block: { type: "tool_result", tool_use_id: id, content: text },
  call: { id, name },
  result: { content: [{ type: "text", text }], isError: false },
})
const bodyFor = content => ({ messages: [{ role: "assistant", content: [] }, { role: "user", content }] })

test("images and dimension notes belong to their preceding result in a batch", () => {
  const a = result("call_a", "Read", "first")
  const b = result("call_b", "Read", "second")
  const body = bodyFor([a.block, image, { type: "text", text: "[Image: first screenshot]" }, b.block])
  const { results } = inspectToolTurn([a, b], body)
  assert.deepEqual(results[0].result.content.map(part => part.type), ["text", "image", "text"])
  assert.equal(results[0].result.content[1].data, image.source.data)
  assert.deepEqual(results[1].result.content, [{ type: "text", text: "second" }])
})

test("a companion cannot attach to a different preceding tool", () => {
  const skill = result("call_skill", "Skill", "Launching skill: review")
  const read = result("call_read", "Read", "file text")
  for (const text of ["ARGUMENTS: review", "Tool loaded.", "[Image: screenshot]"]) {
    assert.throws(() => inspectToolTurn([skill, read], bodyFor([skill.block, read.block, { type: "text", text }])), /text beside a live tool_result/)
  }
})

test("Codex context notices and mid-turn steered user text keep live session", () => {
  const patch = result("call_patch", "apply_patch", "Success. Updated files")
  const timeTag = "<codex_apps_client_time_context><timezone>Asia/Taipei</timezone>\n<current_date>2026-11-05</current_date></codex_apps_client_time_context>"
  const collabTag = "<collaboration_mode># Collaboration Mode: Default\nChanges with `<collaboration_mode>...</collaboration_mode>`.</collaboration_mode>"
  const noticeOnly = inspectToolTurn([patch], bodyFor([patch.block, { type: "text", text: timeTag }, { type: "text", text: collabTag }]))
  assert.equal(noticeOnly.userSteered, false)
  assert.ok(noticeOnly.results[0].result.content.at(-1).text.includes("<codex_apps_client_time_context>"))
  const steered = inspectToolTurn([patch], bodyFor([
    patch.block,
    { type: "text", text: timeTag },
    { type: "text", text: "可以升级 重启没关系\nCVE-2026-98432 这个是不是都升级好了\n" },
  ]))
  assert.equal(steered.userSteered, false)
  assert.ok(steered.results[0].result.content.at(-1).text.includes("CVE-2026-98432 这个是不是都升级好了"))

  const steeredWithoutContextTag = inspectToolTurn([patch], bodyFor([
    patch.block,
    { type: "text", text: "现在的版本在 \"D:\\Program Files\\codex-lite.exe\"\n" },
  ]))
  assert.equal(steeredWithoutContextTag.userSteered, false)
  assert.ok(steeredWithoutContextTag.results[0].result.content.at(-1).text.includes("现在的版本在 \"D:\\Program Files\\codex-lite.exe\""))

  const skill = result("call_skill", "Skill", "Launching skill: archive")
  const steeredSkill = inspectToolTurn([skill], bodyFor([
    skill.block,
    { type: "text", text: "Stop this task and explain something else" },
  ]))
  assert.equal(steeredSkill.userSteered, true)

  const standaloneFollowUpBody = {
    messages: [
      { role: "assistant", content: [] },
      { role: "user", content: [patch.block] },
      { role: "user", content: "Standalone follow-up user instruction" },
    ],
  }
  assert.throws(() => inspectToolTurn([patch], standaloneFollowUpBody), /text beside a live tool_result/)
  assert.equal(canReplayFollowUpAfterResults(standaloneFollowUpBody, [patch]), true)

  assert.throws(
    () => inspectToolTurn([patch], bodyFor([patch.block, { type: "text", text: "extra user text\n<task-notification>background completed</task-notification>" }])),
    /text beside a live tool_result/,
  )
})

test("a partial ID rename maps by full history without discarding the live ID anchor", () => {
  const original = [
    { type: "tool_use", id: "original_a", name: "Read", input: { path: "a" } },
    { type: "tool_use", id: "original_b", name: "Read", input: { path: "b" } },
  ]
  const expectedMessages = [{ role: "user", content: "read both" }, { role: "assistant", content: original }]
  const history = structuredClone(expectedMessages)
  history[1].content[1].id = "renamed_b"
  const turn = { finalized: false }
  const proc = { turn, expectedMessages, matchesHistory: value => historyKey(value) === historyKey(expectedMessages) }
  const calls = original.map(call => ({ ...call, mcpResponded: false }))
  allProcs.add(proc)
  calls.forEach(call => toolCalls.set(call.id, { proc, turn, call }))
  try {
    const blocks = ["original_a", "renamed_b"].map(id => ({ type: "tool_result", tool_use_id: id, content: "done" }))
    const matched = matchToolResults({ messages: [...history, { role: "user", content: blocks }] }, blocks)
    assert.deepEqual(matched.map(item => item.match?.call?.id), ["original_a", "original_b"])
  } finally {
    allProcs.delete(proc)
    calls.forEach(call => toolCalls.delete(call.id))
  }
})

test("history replay keeps image bytes between their original surrounding text", () => {
  const parts = renderInitialPromptParts({ messages: [
    { role: "user", content: [{ type: "text", text: "before first image" }, image, { type: "text", text: "after first image" }] },
    { role: "assistant", content: "old reply" },
    { role: "user", content: "current question" },
  ] }, null, true)
  assert.deepEqual(parts.map(part => part.type), ["text", "image", "text"])
  assert.ok(parts[0].text.endsWith("Human: before first image"))
  assert.ok(parts[2].text.startsWith("after first image\nAssistant: old reply"))
  assert.ok(parts[2].text.endsWith("<current_turn>\ncurrent question\n</current_turn>"))
})

test("state lock recovers a stale lock only after its owning process has exited", () => {
  const file = path.join(workspace, "dead-owner-state.json")
  fs.writeFileSync(file + ".lock", JSON.stringify({ pid: 2147483647 }))
  const old = new Date(Date.now() - 10_000)
  fs.utimesSync(file + ".lock", old, old)
  let wrote = false
  withStateLock(file, () => { wrote = true })
  assert.equal(wrote, true)
  assert.equal(fs.existsSync(file + ".lock"), false)
})

test("Turn.pushText emits regular trailing newline immediately and withholds error marker", () => {
  const proc = {}
  const turn1 = new Turn(proc, [{ role: "user", content: "hi" }])
  turn1.pushText("line 1\n")
  assert.equal(turn1.heldText, "")
  assert.deepEqual(turn1.events, [{ type: "text", text: "line 1\n" }])

  const turn2 = new Turn(proc, [{ role: "user", content: "hi" }])
  turn2.pushText("hello\n⚠ Agent ")
  assert.equal(turn2.heldText, "\n⚠ Agent ")
  assert.deepEqual(turn2.events, [{ type: "text", text: "hello" }])
  assert.equal(turn2.agentError, false)

  turn2.pushText("execution terminated due to error.\n")
  assert.equal(turn2.agentError, true)
  assert.equal(turn2.heldText, "")
})

test("translateUsage deducts cached tokens when included in inputTokens, and shares multi-step tokens", () => {
  const usageWithCache = {
    inputTokens: 1000,
    cachedReadTokens: 400,
    cachedWriteTokens: 0,
    outputTokens: 100,
    thoughtTokens: 50,
    totalTokens: 1150,
  }
  const singleStep = translateUsage(usageWithCache, 1, 0)
  assert.equal(singleStep.input_tokens, 600)
  assert.equal(singleStep.cache_read_input_tokens, 400)
  assert.equal(singleStep.output_tokens, 150)
  assert.deepEqual(singleStep.output_tokens_details, { thinking_tokens: 50 })

  const multiStepUsage = {
    inputTokens: 600,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    outputTokens: 200,
    thoughtTokens: 60,
    totalTokens: 860,
  }
  const multiStep = translateUsage(multiStepUsage, 2, 80)
  assert.equal(multiStep.input_tokens, 300)
  assert.equal(multiStep.output_tokens, 150)
  assert.deepEqual(multiStep.output_tokens_details, { thinking_tokens: 30 })
})

test("conversationKey discriminates conversations using session_id, user, and prompt_cache_key", () => {
  const base = {
    system: "You are a test assistant.",
    messages: [{ role: "user", content: "Hello" }],
  }
  const keyBase = conversationKey(base)
  const keyUserId = conversationKey({ ...base, metadata: { user_id: "u1" } })
  const keySessionId = conversationKey({ ...base, metadata: { session_id: "sess_123" } })
  const keyUser = conversationKey({ ...base, user: "user_abc" })
  const keyPromptCacheKey = conversationKey({ ...base, prompt_cache_key: "cache_xyz" })

  const keys = [keyBase, keyUserId, keySessionId, keyUser, keyPromptCacheKey]
  assert.equal(new Set(keys).size, keys.length, "each discriminator should produce a unique conversationKey")
})

test("x-magpie-session header and instructionsKey/historyKey normalize dynamic masking, Alma context, and time blocks", async () => {
  const plugin = await AntigravityBridgePlugin()
  assert.equal(plugin["chat.headers"], undefined)

  const base = {
    system: "You are a helpful coding assistant.",
    messages: [{ role: "user", content: "Hello" }],
  }
  const keyWithHeader = conversationKey(base, { headers: { "x-magpie-session": "real-sess-001" } })
  const keyWithSubagent = conversationKey(base, { headers: { "x-magpie-session": "real-sess-001", "x-magpie-subagent": "sub-1" } })
  const keyWithoutHeader = conversationKey(base, {})
  assert.notEqual(keyWithHeader, keyWithoutHeader)
  assert.notEqual(keyWithHeader, keyWithSubagent)

  const keySyntheticA = conversationKey(base, { headers: { "x-magpie-session": "magpie-895e850341afd28a69ad4cf6" } })
  const keySyntheticB = conversationKey(base, { headers: { "x-magpie-session": "magpie-4f111a4bff02f8e44e83c625" } })
  assert.equal(keySyntheticA, keyWithoutHeader)
  assert.equal(keySyntheticB, keyWithoutHeader)

  const sysPlain = "You are {{PERSON_iekwuhjr}}\n<codex_apps_client_time_context>2026-11-06T01:00:00Z</codex_apps_client_time_context>"
  const sysMaskedAndLater = `You are {{PERSON_ohnu7ekb}}\n<codex_apps_client_time_context>2026-11-06T02:00:00Z</codex_apps_client_time_context>\n\n${MAGPIE_PLACEHOLDER_NOTICE}`
  assert.equal(instructionsKey(sysPlain), instructionsKey(sysMaskedAndLater))
  assert.ok(extractDynamicSystemBlocks(sysMaskedAndLater).includes(MAGPIE_PLACEHOLDER_NOTICE))

  const almaMsgA = {
    role: "user",
    content: [
      { type: "text", text: "[Context: <reminder>Authoritative Local DateTime: 2026-11-06 03:27:41</reminder>]\n\n## Relevant Memories\n1. user{{ACCOUNT_t4bc7dsi}}" },
      { type: "text", text: "[Message sent-at: 2026-11-06 03:27:38 Fri]" },
      { type: "text", text: `test\n\n${MAGPIE_PLACEHOLDER_NOTICE}` },
    ],
  }
  const almaMsgB = {
    role: "user",
    content: [
      { type: "text", text: "[Context: <reminder>Authoritative Local DateTime: 2026-11-06 03:28:19</reminder>]\n\n## Relevant Memories\n1. user{{ACCOUNT_zzzz9999}}" },
      { type: "text", text: "[Message sent-at: 2026-11-06 03:27:38 Fri]" },
      { type: "text", text: "test" },
    ],
  }
  assert.equal(historyKey([almaMsgA]), historyKey([almaMsgB]))
})

test("normalizeTools filters tool names exceeding agy 64-char prefixed limit and prefixToolSearchText prefixes unlocked tools", () => {
  const tools = normalizeTools({
    tools: [
      { name: "multi_agent_v1__spawn_agent", description: "Spawn subagent", input_schema: { type: "object" } },
      { name: "mcp__codex_security__update_codex_security_scan_context", description: "Too long (69 chars with prefix)", input_schema: { type: "object" } },
    ],
  })
  assert.deepEqual(tools.map(t => t.name), ["multi_agent_v1__spawn_agent"])

  const block = {
    type: "tool_result",
    tool_use_id: "call_ts_1",
    content: "These tools are now available to call: multi_agent_v1__wait_agent, multi_agent_v1__spawn_agent",
  }
  const res = toolResult(block)
  assert.equal(
    res.content[0].text,
    "These tools are now available to call: mcp_ide-tools_multi_agent_v1__wait_agent, mcp_ide-tools_multi_agent_v1__spawn_agent",
  )
  assert.ok(blockText(block).includes("mcp_ide-tools_multi_agent_v1__spawn_agent"))
})

test("normalizeTools predeclares Codex multi_agent_v1 tools when tool_search and exec_command are present", () => {
  const initialTools = normalizeTools({
    tools: [
      { name: "exec_command", description: "Run command", input_schema: { type: "object" } },
      { name: "tool_search", description: "Search deferred tools", input_schema: { type: "object" } },
    ],
  })
  const names = initialTools.map((t) => t.name)
  assert.ok(names.includes("multi_agent_v1__spawn_agent"))
  assert.ok(names.includes("multi_agent_v1__wait_agent"))
  assert.ok(names.includes("multi_agent_v1__send_input"))
  assert.ok(names.includes("multi_agent_v1__close_agent"))
  assert.ok(names.includes("multi_agent_v1__resume_agent"))
})

test("readStepTranscriptUsage preserves cache_read_input_tokens across sub-steps of the same PLANNER_RESPONSE", () => {
  const sessionId = "test-session-" + Date.now()
  const logDir = path.join(bridgeGeminiDir(), "antigravity-cli", "brain", sessionId, ".system_generated", "logs")
  fs.mkdirSync(logDir, { recursive: true })
  const transcriptPath = path.join(logDir, "transcript.jsonl")
  try {
    fs.writeFileSync(transcriptPath, [
      JSON.stringify({ step_index: 0, type: "USER_INPUT" }),
      JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", input_tokens: 2307, cache_read_tokens: 38707, output_tokens: 1647 }),
    ].join("\n") + "\n")
    const proc = { sessionId }
    const first = readStepTranscriptUsage(proc)
    assert.deepEqual(first, {
      input_tokens: 2307,
      output_tokens: 1647,
      cache_read_input_tokens: 38707,
      cache_creation_input_tokens: 0,
      isNewStep: true,
    })
    const secondSameStep = readStepTranscriptUsage(proc)
    assert.deepEqual(secondSameStep, {
      input_tokens: 2307,
      output_tokens: 1647,
      cache_read_input_tokens: 38707,
      cache_creation_input_tokens: 0,
      isNewStep: false,
    })
  } finally {
    fs.rmSync(path.join(bridgeGeminiDir(), "antigravity-cli", "brain", sessionId), { recursive: true, force: true })
  }
})

test("compactSkillsInstructions keeps local skill roots verbatim and compacts remote plugin cache descriptions", () => {
  const sampleBlock = [
    "<skills_instructions>",
    "### Skill roots",
    "- `r0` = `C:/Users/Chris/.codex/skills`",
    "- `r1` = `C:/Users/Chris/.agents/skills`",
    "- `r4` = `C:/Users/Chris/.codex/plugins/cache/openai-curated-remote/vercel/0.54.1/skills`",
    "### Available skills",
    "- local-skill: Detailed local skill description that should remain completely untouched. Use when doing local work and never truncate this second sentence. (file: r0/local-skill/SKILL.md)",
    "- vercel:nextjs: Next.js App Router principles. Server Components, data fetching, rendering strategies, caching, and Vercel deployment optimizations. Use this skill whenever the user mentions Next.js, App Router, Server Actions, or React Server Components. Triggers on next.config.js, page.tsx, layout.tsx. (file: r4/nextjs/SKILL.md)",
    "</skills_instructions>",
  ].join("\n")

  const compacted = compactSkillsInstructions(sampleBlock)
  assert.ok(compacted.includes("- local-skill: Detailed local skill description that should remain completely untouched. Use when doing local work and never truncate this second sentence. (file: r0/local-skill/SKILL.md)"))
  assert.ok(compacted.includes("- vercel:nextjs: Next.js App Router principles. (file: r4/nextjs/SKILL.md)"))
  assert.ok(!compacted.includes("Triggers on next.config.js"))

  const sysOut = sessionInstructions({ system: sampleBlock }, "C:/Users/Chris/Desktop/temp")
  assert.ok(sysOut.includes("- vercel:nextjs: Next.js App Router principles. (file: r4/nextjs/SKILL.md)"))

  const msgOut = renderInitialPromptParts({
    messages: [{ role: "user", content: sampleBlock }],
  }, "C:/Users/Chris/Desktop/temp", true)
  const msgText = msgOut.map((p) => p.text || "").join("\n")
  assert.ok(msgText.includes("- vercel:nextjs: Next.js App Router principles. (file: r4/nextjs/SKILL.md)"))
  assert.ok(!msgText.includes("Triggers on next.config.js"))
})

test("normalizeApplyPatchArgs merges multi-envelope Begin/End Patch blocks into a single valid patch", () => {
  const rawPatch = [
    "*** Begin Patch",
    "*** Update File: C:\\Users\\Chris\\Desktop\\temp\\rate-limit.js",
    "@@",
    "-const a = 1;",
    "+const a = 2;",
    "*** End Patch",
    "*** Begin Patch",
    "*** Update File: C:\\Users\\Chris\\Desktop\\temp\\rate-limit.test.js",
    "@@",
    "-assert.equal(a, 1);",
    "+assert.equal(a, 2);",
    "*** End Patch",
  ].join("\n")

  const out = normalizeApplyPatchArgs("apply_patch", { input: rawPatch })
  assert.deepEqual(out.input.match(/\*\*\* (?:Begin|End) Patch/g), ["*** Begin Patch", "*** End Patch"])
  assert.ok(out.input.includes("*** Update File: C:\\Users\\Chris\\Desktop\\temp\\rate-limit.js"))
  assert.ok(out.input.includes("*** Update File: C:\\Users\\Chris\\Desktop\\temp\\rate-limit.test.js"))
})
