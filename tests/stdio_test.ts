/**
 * Native stdio is the transport Docker MCP Toolkit clients will actually use,
 * so this suite exercises the real server end to end. No mocks: this must
 * prove the MCP SDK's legacy initialize handling and actual tool dispatch.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { TextLineStream } from "@std/streams/text-line-stream";
import denoConfig from "../deno.json" with { type: "json" };

const RUN_PUBLISHED_ARTIFACTS =
  Deno.env.get("PRUSASLICER_RUN_PUBLISHED_ARTIFACTS") === "1";
const DOCUMENTED_GHCR_IMAGE =
  "ghcr.io/casys-ai/mcp-prusaslicer@sha256:e63093777eff5f766e51acf1afe7cdb3b0e20c133cff93ad0d3e3b9b979e1ab3";
// CI injects these only after the registry and Buildx have published immutable
// identities. The local defaults are the documented historical artifacts.
const PUBLISHED_JSR_VERSION = Deno.env.get("PUBLISHED_JSR_VERSION") ??
  denoConfig.version;
const PUBLISHED_GHCR_IMAGE = Deno.env.get("PUBLISHED_GHCR_IMAGE") ??
  DOCUMENTED_GHCR_IMAGE;
const STDIO_TIMEOUT_MS = 30_000;
const PUBLISHED_ARTIFACT_TIMEOUT_MS = 120_000;
const CHILD_SHUTDOWN_TIMEOUT_MS = 1_000;

function isAllowedPublishedImage(image: string): boolean {
  return /^ghcr\.io\/(?:casys-ai|superworldsavior)\/mcp-prusaslicer@sha256:[a-f0-9]{64}$/
    .test(image);
}

Deno.test("published image coordinate restricts namespace, package and digest", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  assert(isAllowedPublishedImage(`ghcr.io/casys-ai/mcp-prusaslicer@${digest}`));
  assert(isAllowedPublishedImage(`ghcr.io/superworldsavior/mcp-prusaslicer@${digest}`));
  for (
    const image of [
      `ghcr.io/another-owner/mcp-prusaslicer@${digest}`,
      `ghcr.io/superworldsavior/another-package@${digest}`,
      "ghcr.io/superworldsavior/mcp-prusaslicer:latest",
      `ghcr.io/superworldsavior/mcp-prusaslicer@sha256:${"a".repeat(63)}`,
      `ghcr.io/superworldsavior/mcp-prusaslicer@sha256:${"g".repeat(64)}`,
    ]
  ) {
    assert(!isAllowedPublishedImage(image), `unexpected allowed image ${image}`);
  }
});

class StdioTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for native stdio response.`);
    this.name = "StdioTimeoutError";
  }
}

async function readWithAbort<T>(
  pendingRead: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  if (signal.aborted) throw new StdioTimeoutError(timeoutMs);

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new StdioTimeoutError(timeoutMs));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pendingRead, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function collectResponses(
  stdout: ReadableStream<Uint8Array>,
  expected: number,
  timeoutMs: number,
): Promise<Record<string, unknown>[]> {
  const responses: Record<string, unknown>[] = [];
  const lines = stdout
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream());
  const reader = lines.getReader();
  const timeout = new AbortController();
  const timeoutId = setTimeout(() => timeout.abort(), timeoutMs);
  let cancellation: Promise<void> | undefined;
  const cancelReader = () => {
    cancellation ??= reader.cancel().catch(() => {});
    return cancellation;
  };
  const onAbort = () => {
    void cancelReader();
  };
  timeout.signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (responses.length < expected) {
      const { value, done } = await readWithAbort(
        reader.read(),
        timeout.signal,
        timeoutMs,
      );
      if (done) break;
      if (value.trim() === "") continue;
      responses.push(JSON.parse(value) as Record<string, unknown>);
    }
    if (timeout.signal.aborted) {
      throw new StdioTimeoutError(timeoutMs);
    }
  } finally {
    clearTimeout(timeoutId);
    timeout.signal.removeEventListener("abort", onAbort);
    if (timeout.signal.aborted) {
      await cancelReader();
      await reader.closed.catch(() => {});
    }
    reader.releaseLock();
  }
  return responses;
}

async function waitForExit(
  status: Promise<Deno.CommandStatus>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      status.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function stopStdioServer(
  server: Deno.ChildProcess,
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<Deno.CommandStatus> {
  await writer.close().catch(() => {});
  const status = server.status;
  try {
    server.kill("SIGTERM");
  } catch {
    // The server may already have exited after the writer closed.
  }
  if (!await waitForExit(status, CHILD_SHUTDOWN_TIMEOUT_MS)) {
    try {
      server.kill("SIGKILL");
    } catch {
      // The process may have exited between the timeout and the escalation.
    }
  }
  return await status;
}

function spawnNativeStdio(
  command: string,
  args: string[],
): Deno.ChildProcess {
  return new Deno.Command(command, {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
}

async function assertNativeStdioContract(
  spawn: () => Deno.ChildProcess,
  expectedVersion: string,
  timeoutMs = STDIO_TIMEOUT_MS,
): Promise<void> {
  const modern = spawn();
  const modernWriter = modern.stdin.getWriter();
  try {
    await modernWriter.write(new TextEncoder().encode(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }) + "\n",
    ));
    const [discover] = await collectResponses(
      modern.stdout,
      1,
      timeoutMs,
    );
    assertEquals(discover.id, 1);
    const discoverResult = discover.result as Record<string, unknown>;
    assertEquals(discoverResult.resultType, "complete");
    const discoverMeta = discoverResult._meta as Record<string, unknown>;
    const discoverInfo = discoverMeta["io.modelcontextprotocol/serverInfo"] as Record<
      string,
      unknown
    >;
    assertEquals(discoverInfo.name, "mcp-prusaslicer");
    assertEquals(discoverInfo.version, expectedVersion);
  } finally {
    await stopStdioServer(modern, modernWriter);
  }

  const legacy = spawn();
  const legacyWriter = legacy.stdin.getWriter();
  const send = (message: Record<string, unknown>) =>
    legacyWriter.write(new TextEncoder().encode(JSON.stringify(message) + "\n"));
  try {
    await send({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "published-stdio-smoke", version: "0" },
      },
    });
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    await send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "prusaslicer_estimate_fff", arguments: {} },
    });

    const responses = await collectResponses(legacy.stdout, 3, timeoutMs);
    const initialize = responses[0].result as Record<string, unknown>;
    assertEquals(responses[0].id, 2);
    assertEquals(initialize.protocolVersion, "2025-06-18");
    const initializeInfo = initialize.serverInfo as Record<string, unknown>;
    assertEquals(initializeInfo.name, "mcp-prusaslicer");
    assertEquals(initializeInfo.version, expectedVersion);

    assertEquals(responses[1].id, 3);
    const tools = (responses[1].result as Record<string, unknown>).tools as Array<
      { name: string }
    >;
    assert(tools.some((tool) => tool.name === "prusaslicer_estimate_fff"));

    const toolCall = responses[2];
    assertEquals(toolCall.id, 4);
    const error = toolCall.error as { code?: unknown } | undefined;
    const result = toolCall.result as { isError?: unknown } | undefined;
    const text = JSON.stringify(toolCall);
    assert(
      error !== undefined || result?.isError === true,
      `incomplete tool call must be refused by schema validation, got: ${text}`,
    );
    assert(
      error?.code !== -32020,
      `tools/call must reach schema validation, got: ${text}`,
    );
  } finally {
    await stopStdioServer(legacy, legacyWriter);
  }
}

Deno.test(
  "native stdio serves modern server/discover as its first request",
  async () => {
    const server = spawnNativeStdio(Deno.execPath(), [
      "run",
      "--allow-all",
      new URL("../server.ts", import.meta.url).pathname,
      "--stdio",
    ]);

    const writer = server.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }) + "\n",
      ));

      const responses = await collectResponses(server.stdout, 1, STDIO_TIMEOUT_MS);
      assertEquals(responses.length, 1);
      assertEquals(responses[0].id, 1);
      const result = responses[0].result as Record<string, unknown>;
      assertEquals(result.resultType, "complete");
      const meta = result._meta as Record<string, unknown>;
      const serverInfo = meta["io.modelcontextprotocol/serverInfo"] as Record<
        string,
        unknown
      >;
      assertEquals(serverInfo.name, "mcp-prusaslicer");
      assertEquals(serverInfo.version, denoConfig.version);
    } finally {
      await stopStdioServer(server, writer);
    }
  },
);

Deno.test(
  "native stdio accepts legacy initialize and dispatches tools/call to the tool schema",
  async () => {
    const server = spawnNativeStdio(Deno.execPath(), [
      "run",
      "--allow-all",
      new URL("../server.ts", import.meta.url).pathname,
      "--stdio",
    ]);

    const writer = server.stdin.getWriter();
    const send = (message: Record<string, unknown>) =>
      writer.write(new TextEncoder().encode(JSON.stringify(message) + "\n"));

    try {
      await send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "native-stdio-test", version: "0" },
        },
      });
      await send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      await send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "prusaslicer_estimate_fff",
          // Deliberately incomplete: this must reach native tool schema validation.
          arguments: {},
        },
      });

      const responses = await collectResponses(server.stdout, 3, STDIO_TIMEOUT_MS);
      assertEquals(
        responses.length,
        3,
        "expected initialize, tools/list, and tools/call responses",
      );

      const init = responses[0].result as Record<string, unknown>;
      assertEquals(responses[0].id, 1);
      assertEquals(
        init.protocolVersion,
        "2025-06-18",
        "native stdio must negotiate the legacy client revision",
      );
      const serverInfo = init.serverInfo as Record<string, unknown>;
      assertEquals(serverInfo.name, "mcp-prusaslicer");
      assertEquals(
        serverInfo.version,
        denoConfig.version,
        "stdio initialize version must match the package manifest",
      );

      const listed = responses[1].result as Record<string, unknown>;
      assertEquals(responses[1].id, 2);
      const names = (listed.tools as { name: string }[]).map((t) => t.name).sort();
      assertEquals(names, [
        "prusaslicer_estimate_fff",
      ]);

      const toolCall = responses[2];
      assertEquals(toolCall.id, 3);
      const toolCallError = toolCall.error as
        | { code?: unknown }
        | undefined;
      const toolCallResult = toolCall.result as
        | { isError?: unknown }
        | undefined;
      const toolCallText = JSON.stringify(toolCall);
      assert(
        toolCallError !== undefined || toolCallResult?.isError === true,
        `incomplete tool call must be refused by the tool schema, got: ${toolCallText}`,
      );
      assert(
        toolCallError?.code !== -32020,
        `tools/call must reach native schema validation, got: ${toolCallText}`,
      );
      assert(
        toolCallText.includes("stl_path") ||
          toolCallText.includes("profile_ini_path") ||
          toolCallText.includes("Invalid arguments"),
        `tool call must reach schema validation, got: ${toolCallText}`,
      );
    } finally {
      await stopStdioServer(server, writer);
    }
  },
);

Deno.test(
  "native stdio surfaces the server's typed refusal instead of inventing a success",
  async () => {
    const server = spawnNativeStdio(Deno.execPath(), [
      "run",
      "--allow-all",
      new URL("../server.ts", import.meta.url).pathname,
      "--stdio",
    ]);

    const writer = server.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "no/such-method",
          params: {},
        }) + "\n",
      ));
      const responses = await collectResponses(server.stdout, 1, STDIO_TIMEOUT_MS);
      assertEquals(responses.length, 1);
      assertEquals(responses[0].id, 7);
      assert(
        responses[0].error !== undefined,
        "an unknown method must come back as a JSON-RPC error, never silence",
      );
    } finally {
      await stopStdioServer(server, writer);
    }
  },
);

Deno.test(
  "native stdio timeout aborts a pending read and terminates a silent child",
  async () => {
    const silent = spawnNativeStdio(Deno.execPath(), [
      "eval",
      "await new Promise(() => setInterval(() => {}, 1_000))",
    ]);
    const writer = silent.stdin.getWriter();
    const timeoutMs = 50;
    const startedAt = performance.now();
    try {
      await assertRejects(
        () => collectResponses(silent.stdout, 1, timeoutMs),
        StdioTimeoutError,
        `Timed out after ${timeoutMs}ms`,
      );
      assert(
        performance.now() - startedAt < CHILD_SHUTDOWN_TIMEOUT_MS,
        "a silent native stdio child must fail within the bounded timeout",
      );
    } finally {
      const status = await stopStdioServer(silent, writer);
      assert(
        !status.success,
        "the silent child must be terminated after its read is cancelled",
      );
    }
  },
);

Deno.test(
  {
    name: "published artifacts pass the native stdio contract",
    ignore: !RUN_PUBLISHED_ARTIFACTS,
    async fn(t) {
      assert(
        isAllowedPublishedImage(PUBLISHED_GHCR_IMAGE),
        "the GHCR smoke target must be an immutable digest reference",
      );

      await t.step("published JSR package", () =>
        assertNativeStdioContract(
          () =>
            spawnNativeStdio(Deno.execPath(), [
              "run",
              "--minimum-dependency-age=0",
              "--allow-all",
              `jsr:@casys/mcp-prusaslicer@${PUBLISHED_JSR_VERSION}/server`,
              "--stdio",
            ]),
          PUBLISHED_JSR_VERSION,
          PUBLISHED_ARTIFACT_TIMEOUT_MS,
        ));
      await t.step("published GHCR image", () =>
        assertNativeStdioContract(
          () =>
            spawnNativeStdio("docker", [
              "run",
              "--rm",
              "-i",
              PUBLISHED_GHCR_IMAGE,
              "stdio",
            ]),
          denoConfig.version,
          PUBLISHED_ARTIFACT_TIMEOUT_MS,
        ));
    },
  },
);

Deno.test("documented GHCR smoke target remains pinned", async () => {
  const readme = await Deno.readTextFile(new URL("../README.md", import.meta.url));
  assert(
    readme.includes(DOCUMENTED_GHCR_IMAGE),
    "the default GHCR smoke target must remain the documented immutable digest",
  );
});
