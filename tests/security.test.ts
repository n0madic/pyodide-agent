import { dirname, fromFileUrl, join } from "@std/path";

const dec = new TextDecoder();
const repoRoot = dirname(dirname(fromFileUrl(import.meta.url)));
const runtimeModuleUrl =
  new URL("../src/pyodide-runtime.ts", import.meta.url).href;
const denoJsonPath = join(repoRoot, "deno.json");
const mainTsPath = join(repoRoot, "src", "main.ts");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runRuntimeSnippet(
  source: string,
  {
    env,
  }: {
    env?: Record<string, string>;
  } = {},
): Promise<RunResult> {
  const tempDir = await Deno.makeTempDir({ prefix: "pyodide-agent-test-" });
  const scriptPath = join(tempDir, "snippet.ts");
  await Deno.writeTextFile(scriptPath, source);

  try {
    const output = await new Deno.Command("deno", {
      args: [
        "run",
        "--config",
        denoJsonPath,
        "--unstable-worker-options",
        "--allow-read",
        "--allow-write",
        "--allow-net=cdn.jsdelivr.net",
        "--allow-import=cdn.jsdelivr.net,jsr.io",
        ...(env ? [`--allow-env=${Object.keys(env).join(",")}`] : []),
        scriptPath,
      ],
      cwd: repoRoot,
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();

    return {
      code: output.code,
      stdout: dec.decode(output.stdout),
      stderr: dec.decode(output.stderr),
    };
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

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
