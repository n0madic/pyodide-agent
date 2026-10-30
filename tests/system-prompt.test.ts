import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  HELPER_MODULE,
  HELPER_REGISTRY,
  resolveHelpers,
} from "../src/helpers.ts";
import { resolvePackages } from "../src/pyodide-config.ts";
import { buildSystemPrompt } from "../src/system-prompt.ts";
import { buildTools, MAX_TOOL_OUTPUT_CHARS } from "../src/tool-defs.ts";
import { runPythonOk } from "./_pyodide.ts";

const ALL_NAMES = HELPER_REGISTRY.map((h) => h.name);
const NET_NAMES = HELPER_REGISTRY.filter((h) => h.group === "net").map((h) =>
  h.name
);
const NON_NET_NAMES = ALL_NAMES.filter((n) => !NET_NAMES.includes(n));

interface Mode {
  label: string;
  allowNet: boolean;
  mountDir?: string;
}

const MODES: Mode[] = [
  { label: "bare", allowNet: false },
  { label: "net", allowNet: true },
  { label: "mount", allowNet: false, mountDir: "/data" },
  { label: "net+mount", allowNet: true, mountDir: "/data" },
];

function render(mode: Mode) {
  const helpers = resolveHelpers({
    allowNet: mode.allowNet,
    hasMount: !!mode.mountDir,
  });
  const prompt = buildSystemPrompt({
    mountDir: mode.mountDir,
    packages: resolvePackages(undefined, mode.allowNet),
    helpers,
    allowNet: mode.allowNet,
  });
  const tool = buildTools({ mountDir: mode.mountDir, allowNet: mode.allowNet });
  const toolDesc = tool[0].type === "function"
    ? tool[0].function.description ?? ""
    : "";
  return { helpers, prompt, toolDesc };
}

// A helper is "mentioned" when called (`name(`) or quoted (`` `name` ``); plain
// English uses of words like "fetch" in unrelated prose do not count.
const word = (name: string) => new RegExp(`\\b${name}\\(|\`${name}\``);

function section(prompt: string, heading: string): string {
  const start = prompt.indexOf(heading);
  assert(start >= 0, `missing section ${heading}`);
  const rest = prompt.slice(start + heading.length);
  const next = rest.search(/\n#{2,3} /);
  return next < 0 ? rest : rest.slice(0, next);
}

for (const mode of MODES) {
  Deno.test(`prompt/helpers [${mode.label}]: net helpers appear iff network is on`, () => {
    const { helpers, prompt, toolDesc } = render(mode);
    for (const name of NET_NAMES) {
      assertEquals(
        helpers.names.includes(name),
        mode.allowNet,
        `${name} in resolution`,
      );
      assertEquals(
        word(name).test(prompt),
        mode.allowNet,
        `${name} in prompt`,
      );
      // The tool description never advertises helpers.
      assert(!word(name).test(toolDesc), `${name} leaked into tool description`);
    }
  });

  Deno.test(`prompt/helpers [${mode.label}]: always-available helpers are defined and listed`, () => {
    const { helpers, prompt } = render(mode);
    for (const name of NON_NET_NAMES) {
      assert(helpers.names.includes(name), `${name} not resolved`);
    }
    const listing = section(prompt, "### Helpers");
    for (const spec of HELPER_REGISTRY) {
      if (spec.group === "net" && !mode.allowNet) continue;
      assertStringIncludes(listing, `\`${spec.signature}\``);
    }
  });

  Deno.test(`prompt/example [${mode.label}]: uses only available helpers`, () => {
    const { helpers, prompt } = render(mode);
    const example = section(prompt, "### Example");
    const used = new Set<string>();
    for (const m of example.matchAll(/\b([a-z_]+)\(/g)) {
      if (ALL_NAMES.includes(m[1])) used.add(m[1]);
    }
    for (const name of used) {
      assert(helpers.names.includes(name), `example calls unavailable ${name}()`);
    }
    for (const required of ["step", "check", "emit", "save"]) {
      assert(used.has(required), `example should demonstrate ${required}()`);
    }
    assertEquals(used.has("fetch_many"), mode.allowNet);
    assertEquals(helpers.exampleKind, mode.allowNet ? "net" : "files");
    if (!mode.allowNet) {
      const expected = mode.mountDir ? ["grep"] : ["load", "files"];
      for (const name of expected) assert(used.has(name), `files example: ${name}`);
    }
  });

  Deno.test(`prompt/rules [${mode.label}]: one-script rule, output cap, mount-specific text`, () => {
    const { helpers, prompt, toolDesc } = render(mode);
    assertStringIncludes(prompt, "ONE script per task");
    assertStringIncludes(prompt, String(MAX_TOOL_OUTPUT_CHARS));
    assertStringIncludes(toolDesc, "ONE complete script");
    assertStringIncludes(toolDesc, String(MAX_TOOL_OUTPUT_CHARS));
    assertStringIncludes(prompt, helpers.fsNote.slice(0, 40));

    const overwriteRule = prompt.includes("Never overwrite the user's existing files");
    assertEquals(overwriteRule, !!mode.mountDir);
    assertEquals(helpers.fsNote.includes("/host"), !!mode.mountDir);
    // Without a mount the prompt must not tell the model /host exists.
    if (!mode.mountDir) assert(!prompt.includes("/host"), "/host leaked");
  });
}

Deno.test("prompt: anti-pattern text names no network helpers", () => {
  const { prompt } = render({ label: "bare", allowNet: false });
  const how = section(prompt, "## How to work");
  for (const name of NET_NAMES) assert(!word(name).test(how), name);
});

Deno.test("prompt: network advice follows the resolved helpers, not the allowNet flag", () => {
  const build = (helpersNet: boolean, allowNet: boolean) =>
    buildSystemPrompt({
      packages: resolvePackages(undefined, allowNet),
      helpers: resolveHelpers({ allowNet: helpersNet, hasMount: false }),
      allowNet,
    });
  // Network on but helpers resolved without net: no mention of undefined helpers.
  const noHelpers = build(false, true);
  for (const name of NET_NAMES) assert(!word(name).test(noHelpers), name);
  assertStringIncludes(noHelpers, "requests.get");
  // Both on: the network section recommends the helpers.
  assertStringIncludes(build(true, true), "Prefer the `fetch` / `fetch_many` helpers");
});

Deno.test("prompt: shadow hint names the collision-free module", () => {
  const { prompt } = render({ label: "bare", allowNet: false });
  assertStringIncludes(prompt, `\`${HELPER_MODULE}.files\``);
  assert(!prompt.includes("`helpers.files`"));
});

Deno.test("registry: unique names, signature mentions the name, docs are non-trivial", () => {
  assertEquals(new Set(ALL_NAMES).size, ALL_NAMES.length);
  for (const spec of HELPER_REGISTRY) {
    assert(
      spec.signature.includes(spec.name),
      `${spec.name}: signature should mention the name`,
    );
    assert(spec.doc.length > 10);
  }
});

Deno.test({
  name: "prelude defines exactly the registry names in net mode",
  permissions: { read: true, write: true, run: true },
  async fn() {
    const out = await runPythonOk(
      `
import ${HELPER_MODULE} as helpers
names = ${JSON.stringify(ALL_NAMES)}
missing = [n for n in names if n not in globals()]
assert not missing, missing
assert sorted(helpers.__all__) == sorted(names + ["HelperError"]), helpers.__all__
print("OK")
`,
      { allowNet: true },
    );
    assertStringIncludes(out, "OK");
  },
});
