import { test } from "node:test";
import assert from "node:assert/strict";
import { createStreamFormatter } from "../dist/test/streamfmt.js";

test("createStreamFormatter: onResult fires once per stream-json result line", () => {
  let results = 0;
  const fmt = createStreamFormatter(undefined, () => results++);
  fmt.push('{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}\n');
  assert.equal(results, 0);
  fmt.push('{"type":"result","subtype":"success","is_error":false,"result":"done"}\n');
  assert.equal(results, 1);
  fmt.push("plain text line\n");
  assert.equal(results, 1);
});
