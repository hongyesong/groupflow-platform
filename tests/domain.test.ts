import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveSteps,
  transitions,
  validateSequence,
} from "../server/domain.js";
import { boundedResult } from "../server/agents.js";
test("step variables persist and empty overrides retain their original source", () => {
  const steps = [1, 2, 3].map((index) => ({
    index,
    accountRole: "admin" as const,
    text: "{event} {location}",
    delaySeconds: 1,
  }));
  const result = resolveSteps(
    steps,
    { event: "分享会", location: "A" },
    { "2": { location: "B" }, "3": { location: "" } },
  );
  assert.equal(result[2].text, "分享会 B");
  assert.equal(result[2].varSources.location, "step:2");
  assert.equal(result[0].varSources.location, "default");
});
test("preflight checks later steps and identifies the exact missing key", () => {
  assert.throws(
    () =>
      resolveSteps(
        [
          { index: 1, accountRole: "admin", text: "hello", delaySeconds: 0 },
          {
            index: 2,
            accountRole: "member",
            text: "{missing}",
            delaySeconds: 0,
          },
        ],
        {},
        {},
      ),
    (e: any) =>
      e.code === "UNRESOLVED_PLACEHOLDER" &&
      e.extra.stepIndex === 2 &&
      e.extra.key === "missing",
  );
});
test("terminal accounts cannot be reconnected", () => {
  assert.deepEqual(transitions.suspended, []);
  assert.deepEqual(transitions.session_expired, []);
  assert.ok(!transitions.rate_limited.includes("idle"));
});
test("sequence indexes cannot skip numbers", () => {
  assert.throws(() =>
    validateSequence([
      { index: 2, accountRole: "admin", text: "x", delaySeconds: 1 },
    ]),
  );
});
test("UTF-8 tool results stay valid JSON below 8KB", () => {
  const r = boundedResult({
    messages: Array.from({ length: 50 }, () => ({ text: "汉".repeat(500) })),
    truncated: false,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 8192);
  assert.equal(r.truncated, true);
  assert.ok(Array.isArray(r.messages));
});
