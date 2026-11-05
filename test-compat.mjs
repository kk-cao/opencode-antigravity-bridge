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
fs.writeFileSync(path.join(workspace, "bridge.mjs"), source + "\nexport { inspectToolTurn, matchToolResults, historyKey, allProcs, toolCalls, renderInitialPromptParts, withStateLock, Turn, translateUsage, conversationKey, instructionsKey, extractDynamicSystemBlocks, MAGPIE_PLACEHOLDER_NOTICE };\n")
const { inspectToolTurn, matchToolResults, historyKey, allProcs, toolCalls, renderInitialPromptParts, withStateLock, Turn, translateUsage, conversationKey, instructionsKey, extractDynamicSystemBlocks, MAGPIE_PLACEHOLDER_NOTICE, AntigravityBridgePlugin } = await import(pathToFileURL(path.join(workspace, "bridge.mjs")).href)
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

test("chat.headers hook passes Magpie sessionID to conversationKey and instructionsKey ignores dynamic masking/time blocks", async () => {
  const plugin = await AntigravityBridgePlugin()
  const out = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "agy-acp" }, sessionID: "magpie-sess-001" }, out)
  assert.equal(out.headers["x-magpie-agy-session"], "magpie-sess-001")

  const base = {
    system: "You are a helpful coding assistant.",
    messages: [{ role: "user", content: "Hello" }],
  }
  const keyWithHeader = conversationKey(base, { headers: out.headers })
  const keyWithoutHeader = conversationKey(base, {})
  assert.notEqual(keyWithHeader, keyWithoutHeader)

  const sysPlain = "Base system prompt\n<codex_apps_client_time_context>2026-11-06T01:00:00Z</codex_apps_client_time_context>"
  const sysMaskedAndLater = `Base system prompt\n<codex_apps_client_time_context>2026-11-06T02:00:00Z</codex_apps_client_time_context>\n\n${MAGPIE_PLACEHOLDER_NOTICE}`
  assert.equal(instructionsKey(sysPlain), instructionsKey(sysMaskedAndLater))
  assert.ok(extractDynamicSystemBlocks(sysMaskedAndLater).includes(MAGPIE_PLACEHOLDER_NOTICE))
})
