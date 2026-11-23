import { test } from "node:test";
import assert from "node:assert/strict";
import { HANDOFF_MARK, NOTE, NOTE_KIND, PASEO_ID, PROMPT_MARK, TRANSFORMERS, transformItem } from "../shared/quiet.js";

test("a user message that starts with the checkpoint mark is removed", () => {
  assert.deepEqual(transformItem({ type: "user_message", text: `${PROMPT_MARK} The session may go idle...` }), { items: [] });
});
test("a handoff reply becomes one grey note row", () => {
  for (const text of [`${HANDOFF_MARK}\nGoal: x`, `  \n${HANDOFF_MARK} Goal: x`, HANDOFF_MARK]) {
    assert.deepEqual(transformItem({ type: "assistant_message", text }), { items: [{ type: "plugin", kind: NOTE_KIND, version: 1, data: { note: NOTE } }] });
  }
});
test("every other item is left alone", () => {
  const others = [
    { type: "user_message", text: "Continue where you left off." },
    { type: "user_message", text: "Continuing from a checkpoint of the previous session x." },
    { type: "user_message", text: `hello ${PROMPT_MARK}` },
    { type: "assistant_message", text: `Here is the ${HANDOFF_MARK}` },
    { type: "assistant_message", text: `${PROMPT_MARK} x` },
    { type: "user_message", text: `${HANDOFF_MARK} x` },
    { type: "tool_call", name: "write", text: `${PROMPT_MARK}` },
    { type: "assistant_message" }, { type: "user_message", text: 5 }, null, undefined, "x",
  ];
  for (const o of others) assert.equal(transformItem(o), undefined, JSON.stringify(o));
});
test("deterministic, and ids pass Paseo's id check", () => {
  const item = { type: "assistant_message", text: `${HANDOFF_MARK} x` };
  assert.equal(JSON.stringify(transformItem(item)), JSON.stringify(transformItem(item)));
  for (const id of [NOTE_KIND, ...TRANSFORMERS.map((t) => t.id)]) assert.ok(PASEO_ID.test(id), id);
});
