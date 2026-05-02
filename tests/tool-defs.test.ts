import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { buildTools } from "../src/tool-defs.ts";

function getDescription(opts: Parameters<typeof buildTools>[0]): string {
  const tools = buildTools(opts);
  assertEquals(tools.length, 1);
  const tool = tools[0];
  assertEquals(tool.type, "function");
  assert(tool.type === "function");
  assertEquals(tool.function.name, "execute_code");
  return tool.function.description ?? "";
}

Deno.test("execute_code description: minimal mode (no host exec, no mount, no net)", () => {
  const desc = getDescription({});
  assertStringIncludes(desc, "Run Python 3 code");
  assertStringIncludes(desc, "scratchpad");
  assertStringIncludes(desc, "Top-level `await` is supported");
  assertStringIncludes(desc, "JS bridge is restricted");
  assertStringIncludes(desc, "Host process execution is disabled");
  assertStringIncludes(desc, "Host filesystem is not accessible");
  assertStringIncludes(desc, "Network is disabled");
});

Deno.test("execute_code description: host exec enabled", () => {
  const desc = getDescription({ allowHostExec: true });
  assertStringIncludes(desc, "Host process execution is available");
  assert(!desc.includes("Host process execution is disabled"));
});

Deno.test("execute_code description: mount-dir mounts /host", () => {
  const desc = getDescription({ mountDir: "/Users/me/notes" });
  assertStringIncludes(desc, "/Users/me/notes");
  assertStringIncludes(desc, "/host");
  assertStringIncludes(desc, "read-write");
  assert(!desc.includes("Host filesystem is not accessible"));
});

Deno.test("execute_code description: network enabled", () => {
  const desc = getDescription({ allowNet: true });
  assertStringIncludes(desc, "HTTP/HTTPS works");
  assertStringIncludes(desc, "requests");
  assertStringIncludes(desc, "pyodide.http.pyfetch");
  assertStringIncludes(desc, "`urllib.request` does not work");
  assert(!desc.includes("Network is disabled"));
});

Deno.test("execute_code description: all modes enabled", () => {
  const desc = getDescription({
    allowHostExec: true,
    allowNet: true,
    mountDir: "/data",
  });
  assertStringIncludes(desc, "Host process execution is available");
  assertStringIncludes(desc, "/data");
  assertStringIncludes(desc, "HTTP/HTTPS works");
  assert(!desc.includes("disabled"));
  assert(!desc.includes("not accessible"));
});

Deno.test("execute_code description does not leak CLI flag names", () => {
  const variants = [
    {},
    { allowHostExec: true },
    { allowNet: true },
    { mountDir: "/x" },
    { allowHostExec: true, allowNet: true, mountDir: "/x" },
  ];
  for (const opts of variants) {
    const desc = getDescription(opts);
    assert(
      !desc.includes("--allow-host-exec"),
      `should not mention --allow-host-exec: ${desc}`,
    );
    assert(
      !desc.includes("--allow-net"),
      `should not mention --allow-net: ${desc}`,
    );
    assert(
      !desc.includes("--mount-dir"),
      `should not mention --mount-dir: ${desc}`,
    );
  }
});
