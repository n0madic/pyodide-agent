# syntax=docker/dockerfile:1.7

# ── Builder: cache Deno deps + pre-warm default Pyodide wheels ────────────
FROM denoland/deno:alpine AS builder
WORKDIR /build

# Pin the Deno dep cache location so we can copy it into the runtime stage.
ENV DENO_DIR=/deno-cache

COPY deno.json deno.lock* ./
COPY src ./src
COPY scripts ./scripts

# Populate DENO_DIR with npm:openai, npm:commander, npm:pyodide, @std/path.
RUN deno cache src/main.ts

# Pre-warm default Pyodide wheels into the same DENO_DIR so first run in the
# runtime image is offline. `deno eval` runs with implicit full permissions,
# so no --allow-* flags are accepted here. We call Pyodide directly (not the
# agent) to avoid needing an OPENAI_API_KEY at build time.
RUN deno eval \
    'import m from "npm:pyodide@^0.29.3/pyodide.js"; \
     const { loadPyodide } = m; \
     const py = await loadPyodide(); \
     await py.loadPackage(["micropip","ssl","pyodide-http","pyyaml","python-dateutil", \
       "requests","certifi","idna","urllib3","charset-normalizer"], \
       { messageCallback: console.log, errorCallback: console.error }); \
     console.log("prewarm complete");'

# ── Runtime: Deno + source + warmed cache, non-root ───────────────────────
FROM denoland/deno:alpine
ENV DENO_DIR=/home/agent/.deno

RUN addgroup -S agent && adduser -S -G agent -h /home/agent agent \
 && mkdir -p /work /home/agent/app "$DENO_DIR" \
 && chown -R agent:agent /work /home/agent

COPY --from=builder --chown=agent:agent /deno-cache "$DENO_DIR"
COPY --from=builder --chown=agent:agent /build/deno.json /build/deno.lock* /home/agent/app/
COPY --from=builder --chown=agent:agent /build/src /home/agent/app/src
COPY --from=builder --chown=agent:agent /build/scripts /home/agent/app/scripts

USER agent
WORKDIR /work

# Default entrypoint matches `deno task start:docker`: scoped net to OpenAI + the
# Pyodide CDN, no arbitrary outbound from Python. Pass `--allow-net` (on
# both sides: override ENTRYPOINT with broad Deno flags + add the CLI flag)
# to turn on Python HTTPS.
# (env vars come in via `docker run --env-file=...` or `-e`, not deno's own
# --env-file, since the .env file isn't copied into the image.) The task uses
# an absolute module path because the runtime container's working directory is /work.
ENTRYPOINT ["deno", "task", "--config", "/home/agent/app/deno.json", "start:docker"]
CMD []
