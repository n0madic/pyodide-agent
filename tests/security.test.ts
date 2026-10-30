import { join } from "@std/path";
import {
  denoJsonPath,
  mainTsPath,
  runRuntimeSnippet,
  runtimeModuleUrl,
} from "./_pyodide.ts";

Deno.test({
  name: "runtime blocks importing Deno from Python js bridge",
  permissions: { read: true, write: true, run: true },
  async fn() {
    const result = await runRuntimeSnippet(`
    import { closePyodide, initPyodide, executeCode, resolvePackages } from ${
      JSON.stringify(runtimeModuleUrl)
    };

    await initPyodide({
      packages: resolvePackages(undefined, false),
    });
    const execResult = await executeCode("from js import Deno\\nprint(Deno.cwd())");
    console.log(JSON.stringify(execResult));
    closePyodide();
  `);

    if (result.code !== 0) {
      throw new Error(`snippet failed unexpectedly:\n${result.stderr}`);
    }

    const parsed = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      stdout: string;
      stderr: string;
    };

    if (parsed.ok) {
      throw new Error(
        `expected Python execution to fail, got stdout=${
          JSON.stringify(parsed.stdout)
        }`,
      );
    }
    if (!parsed.stderr.includes("cannot import name 'Deno'")) {
      throw new Error(
        `expected Deno import failure, got stderr=${parsed.stderr}`,
      );
    }
  },
});

Deno.test({
  name: "runtime blocks reading env vars through Python js bridge",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const result = await runRuntimeSnippet(
      `
      import { closePyodide, initPyodide, executeCode, resolvePackages } from ${
        JSON.stringify(runtimeModuleUrl)
      };

      await initPyodide({
        packages: resolvePackages(undefined, false),
      });
      const execResult = await executeCode("from js import Deno\\nprint(Deno.env.get('PYODIDE_AGENT_TEST_SECRET'))");
      console.log(JSON.stringify(execResult));
      closePyodide();
    `,
      { env: { PYODIDE_AGENT_TEST_SECRET: "super-secret-value" } },
    );

    if (result.code !== 0) {
      throw new Error(`snippet failed unexpectedly:\n${result.stderr}`);
    }

    const parsed = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      stdout: string;
      stderr: string;
    };

    if (parsed.ok) {
      throw new Error(
        `expected env access to fail, got stdout=${
          JSON.stringify(parsed.stdout)
        }`,
      );
    }
    if (!parsed.stderr.includes("cannot import name 'Deno'")) {
      throw new Error(
        `expected Deno import failure, got stderr=${parsed.stderr}`,
      );
    }
  },
});

Deno.test({
  name: "known bypass: curated js globals still reach Deno, but worker permissions hold",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    // Documents (does not endorse) that the restricted jsglobals are only a UX
    // guard. If the first assertion ever starts failing the bypass was closed:
    // update the "Restricted JS globals" notes in CLAUDE.md and README.md.
    // Everything below it must keep failing: that is the real boundary.
    const result = await runRuntimeSnippet(
      `
      import { closePyodide, initPyodide, executeCode, resolvePackages } from ${
        JSON.stringify(runtimeModuleUrl)
      };

      await initPyodide({ packages: resolvePackages(undefined, false) });
      const probes: Record<string, string> = {
        reachesDeno:
          "from js import console\\nprint(console.constructor.constructor('return typeof Deno')())",
        // Each of these must be denied by the worker's permission profile.
        env: "from js import console\\nF = console.constructor.constructor\\nprint(F('return Deno.env.get(\\"PYODIDE_AGENT_TEST_SECRET\\")')())",
        run: "from js import console\\nF = console.constructor.constructor\\nF('return new Deno.Command(\\"echo\\", {args: [\\"hi\\"]}).outputSync()')()",
        readOutsideMount: "from js import console\\nF = console.constructor.constructor\\nprint(F('return Deno.readTextFileSync(\\"/etc/hosts\\")')())",
        writeOutsideMount: "from js import console\\nF = console.constructor.constructor\\nF('return Deno.writeTextFileSync(\\"/tmp/pyodide-agent-escape.txt\\", \\"x\\")')()",
        sys: "from js import console\\nF = console.constructor.constructor\\nprint(F('return Deno.hostname()')())",
      };
      const out: Record<string, unknown> = {};
      for (const [name, code] of Object.entries(probes)) {
        out[name] = await executeCode(code);
      }
      console.log(JSON.stringify(out));
      closePyodide();
    `,
      { env: { PYODIDE_AGENT_TEST_SECRET: "super-secret-value" } },
    );

    if (result.code !== 0) {
      throw new Error(`snippet failed unexpectedly:\n${result.stderr}`);
    }
    const parsed = JSON.parse(result.stdout.trim()) as Record<
      string,
      { ok: boolean; stdout: string; stderr: string }
    >;

    if (!parsed.reachesDeno.ok || parsed.reachesDeno.stdout.trim() !== "object") {
      throw new Error(
        "the Function bypass no longer reaches Deno - the jsglobals gap was " +
          `closed; update CLAUDE.md/README.md. Got ${JSON.stringify(parsed.reachesDeno)}`,
      );
    }
    for (
      const name of ["env", "run", "readOutsideMount", "writeOutsideMount", "sys"]
    ) {
      const r = parsed[name];
      if (r.ok || !/NotCapable|Requires .* access/.test(r.stderr)) {
        throw new Error(
          `worker permissions did not deny '${name}': ${JSON.stringify(r)}`,
        );
      }
      if (r.stdout.includes("super-secret-value")) {
        throw new Error(`secret leaked through '${name}'`);
      }
    }
  },
});

Deno.test({
  name: "mount-dir exposes files through /host without exposing js bridge",
  permissions: { read: true, write: true, run: true },
  async fn() {
    const mountDir = await Deno.makeTempDir({ prefix: "pyodide-agent-mount-" });
    await Deno.writeTextFile(join(mountDir, "note.txt"), "mounted-ok");

    try {
      const result = await runRuntimeSnippet(`
      import { closePyodide, initPyodide, executeCode, resolvePackages } from ${
        JSON.stringify(runtimeModuleUrl)
      };

      await initPyodide({
        mountDir: ${JSON.stringify(mountDir)},
        packages: resolvePackages(undefined, false),
      });
      const readMounted = await executeCode("print(open('/host/note.txt').read())");
      const readDeno = await executeCode("from js import Deno\\nprint(Deno.cwd())");
      console.log(JSON.stringify({ readMounted, readDeno }));
      closePyodide();
    `);

      if (result.code !== 0) {
        throw new Error(`snippet failed unexpectedly:\n${result.stderr}`);
      }

      const parsed = JSON.parse(result.stdout.trim()) as {
        readMounted: { ok: boolean; stdout: string; stderr: string };
        readDeno: { ok: boolean; stdout: string; stderr: string };
      };

      if (
        !parsed.readMounted.ok ||
        parsed.readMounted.stdout.trim() !== "mounted-ok"
      ) {
        throw new Error(
          `expected mounted file read to work, got ${
            JSON.stringify(parsed.readMounted)
          }`,
        );
      }
      if (parsed.readDeno.ok) {
        throw new Error(
          `expected js bridge to stay blocked with mount-dir, got ${
            JSON.stringify(parsed.readDeno)
          }`,
        );
      }
    } finally {
      await Deno.remove(mountDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "start:net does not grant blanket environment access",
  permissions: { read: true },
  async fn() {
    const denoJson = JSON.parse(await Deno.readTextFile(denoJsonPath)) as {
      tasks: Record<string, string>;
    };
    const task = denoJson.tasks["start:net"];
    if (
      task.includes("--allow-env ") || task.includes("--allow-env\n") ||
      task.includes("--allow-env\t")
    ) {
      throw new Error(`start:net still grants blanket env access: ${task}`);
    }
  },
});

Deno.test({
  name: "compile task does not embed env-file values",
  permissions: { read: true },
  async fn() {
    const denoJson = JSON.parse(await Deno.readTextFile(denoJsonPath)) as {
      tasks: Record<string, string>;
    };
    const task = denoJson.tasks.compile;
    if (task.includes("--env-file")) {
      throw new Error(`compile task still embeds .env values: ${task}`);
    }
  },
});

Deno.test({
  name: "startup does not revoke env permissions and trigger permission prompts",
  permissions: { read: true },
  async fn() {
    const mainSource = await Deno.readTextFile(mainTsPath);
    if (mainSource.includes('Deno.permissions.revoke({ name: "env"')) {
      throw new Error("main.ts still revokes env permissions during startup");
    }
  },
});
