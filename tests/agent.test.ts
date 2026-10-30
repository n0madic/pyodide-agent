import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { truncateMiddle } from "../src/agent.ts";

const marker = (n: number) => `${n} characters truncated`;

Deno.test("truncateMiddle: leaves short text alone (boundary included)", () => {
  assertEquals(truncateMiddle("", 10), "");
  assertEquals(truncateMiddle("abc", 10), "abc");
  assertEquals(truncateMiddle("0123456789", 10), "0123456789");
});

Deno.test("truncateMiddle: keeps head and tail, reports the omitted count", () => {
  const text = "A".repeat(50) + "M".repeat(900) + "Z".repeat(50);
  const out = truncateMiddle(text, 100);
  assert(out.startsWith("A".repeat(50) + "\n"), "head kept");
  assert(out.endsWith("\n" + "Z".repeat(50)), "tail kept");
  assertStringIncludes(out, marker(900));
  assert(!out.includes("M"), "middle dropped");
});

Deno.test("truncateMiddle: one char over the limit still truncates", () => {
  const out = truncateMiddle("x".repeat(11), 10);
  assertStringIncludes(out, marker(1));
});

Deno.test("truncateMiddle: never splits a surrogate pair", () => {
  // text units: "a", then 40 emoji (2 units each), then "b".
  const text = "a" + "😀".repeat(40) + "b";
  const split = (out: string) => {
    const [head, rest] = out.split("\n… [");
    const tail = rest.split("] …\n")[1];
    const omitted = Number(/^(\d+) characters truncated/.exec(rest)![1]);
    return { head, tail, omitted };
  };
  // [max, expected head, expected tail]: the half-cut emoji is dropped on either side.
  const cases: [number, string, string][] = [
    [5, "a😀", "b"], // head fits 3 units; tail starts on a low surrogate -> dropped
    [6, "a😀", "😀b"], // both cuts land on boundaries
    [7, "a😀", "😀b"], // head ends on a high surrogate -> dropped
    [8, "a😀", "😀b"], // head 4 units (ends on a high surrogate), tail 4 units (starts on a low one)
    [10, "a😀😀", "😀😀b"], // both cuts land on boundaries
  ];
  for (const [max, head, tail] of cases) {
    const out = truncateMiddle(text, max);
    encodeURIComponent(out); // a lone surrogate would throw here
    const parts = split(out);
    assertEquals(parts.head, head, `head for max=${max}`);
    assertEquals(parts.tail, tail, `tail for max=${max}`);
    assertEquals(parts.omitted, text.length - head.length - tail.length);
  }
});

Deno.test("truncateMiddle: zero budget keeps only the marker", () => {
  const out = truncateMiddle("hello", 0);
  assertStringIncludes(out, marker(5));
});
