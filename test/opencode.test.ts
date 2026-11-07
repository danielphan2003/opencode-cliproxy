// End-to-end: the real `opencode` binary loads the vendored plugin against the mock endpoint.
import { afterAll, describe, expect, test } from "bun:test"
import { modelsOf, sandbox } from "./harness.ts"
import { REPLY, startMock, type MockModel } from "./mock-server.ts"

const TIMEOUT = 60_000

const FULL: MockModel[] = [
  { id: "gpt-5", owned_by: "openai" },
  { id: "gpt-5-mini", owned_by: "openai" },
  { id: "claude-sonnet-4-5", owned_by: "anthropic" },
  { id: "gemini-2.5-pro", owned_by: "google" },
  { id: "local-model", owned_by: "custom" },
]
const LIMITED: MockModel[] = [{ id: "gpt-5-mini", owned_by: "openai" }]

const mock = startMock({ "full-key": FULL, "limited-key": LIMITED })
const slow = startMock({ "full-key": FULL }, { modelsDelayMs: 10_000 })
afterAll(() => {
  mock.stop()
  slow.stop()
})

/** A port nothing listens on: bind one, then release it. */
const closedPort = () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = server.port
  server.stop(true)
  return port
}

const ids = (models: ReadonlyArray<MockModel>, providerID = "cliproxy") => models.map((model) => `${providerID}/${model.id}`).sort()

const withSandbox = async <A>(options: Record<string, unknown>, body: (box: ReturnType<typeof sandbox>) => Promise<A>) => {
  const box = sandbox(options)
  try {
    return await body(box)
  } finally {
    box.cleanup()
  }
}

describe("discovery", () => {
  test(
    "registers every model the key may see, with the key read from {env:...}",
    () =>
      withSandbox({ baseURL: mock.url, apiKey: "{env:CLIPROXY_TEST_KEY}" }, async (box) => {
        const full = await box.run(["models"], { CLIPROXY_TEST_KEY: "full-key" })
        expect(full.code).toBe(0)
        expect(modelsOf(full.stdout, "cliproxy")).toEqual(ids(FULL))

        const limited = await box.run(["models"], { CLIPROXY_TEST_KEY: "limited-key" })
        expect(modelsOf(limited.stdout, "cliproxy")).toEqual(ids(LIMITED))
      }),
    TIMEOUT,
  )

  test(
    "reads the key from {file:...}, ignoring a trailing newline",
    () =>
      withSandbox({ baseURL: mock.url, apiKey: "{file:~/cliproxy.key}" }, async (box) => {
        await Bun.write(`${box.home}/cliproxy.key`, "limited-key\n")
        const result = await box.run(["models"])
        expect(modelsOf(result.stdout, "cliproxy")).toEqual(ids(LIMITED))
      }),
    TIMEOUT,
  )

  test(
    "honours providerID and display name",
    () =>
      withSandbox({ baseURL: mock.url, apiKey: "limited-key", providerID: "proxy", name: "My Proxy" }, async (box) => {
        const result = await box.run(["models"])
        expect(modelsOf(result.stdout, "proxy")).toEqual(ids(LIMITED, "proxy"))
        expect(modelsOf(result.stdout, "cliproxy")).toEqual([])
        const providers = await box.run(["api", "GET", "/api/provider"])
        expect(providers.stdout).toContain('"My Proxy"')
      }),
    TIMEOUT,
  )

  test(
    "falls back to CLIPROXY_BASE_URL and CLIPROXY_API_KEY when options are empty",
    () =>
      withSandbox({}, async (box) => {
        const result = await box.run(["models"], { CLIPROXY_BASE_URL: mock.url, CLIPROXY_API_KEY: "limited-key" })
        expect(modelsOf(result.stdout, "cliproxy")).toEqual(ids(LIMITED))
      }),
    TIMEOUT,
  )
})

describe("filtering", () => {
  test(
    "include and exclude on model ids and owned_by",
    () =>
      withSandbox(
        {
          baseURL: mock.url,
          apiKey: "full-key",
          include: ["gpt-*", "claude-*", "local-*"],
          exclude: ["*-mini"],
          excludeOwnedBy: ["custom"],
        },
        async (box) => {
          const result = await box.run(["models"])
          expect(modelsOf(result.stdout, "cliproxy")).toEqual(["cliproxy/claude-sonnet-4-5", "cliproxy/gpt-5"])
        },
      ),
    TIMEOUT,
  )

  test(
    "includeOwnedBy",
    () =>
      withSandbox({ baseURL: mock.url, apiKey: "full-key", includeOwnedBy: ["google"] }, async (box) => {
        const result = await box.run(["models"])
        expect(modelsOf(result.stdout, "cliproxy")).toEqual(["cliproxy/gemini-2.5-pro"])
      }),
    TIMEOUT,
  )
})

describe("failure", () => {
  test(
    "an unreachable endpoint registers nothing, logs once, and OpenCode still starts",
    () =>
      withSandbox({ baseURL: `http://127.0.0.1:${closedPort()}/v1`, apiKey: "full-key" }, async (box) => {
        const result = await box.run(["models", "--print-logs", "--log-level", "warn"])
        expect(result.code).toBe(0)
        expect(modelsOf(result.stdout, "cliproxy")).toEqual([])
        expect(result.stdout.trim().length).toBeGreaterThan(0)
        expect(result.stderr.match(/cliproxy: .* is unavailable/g)).toHaveLength(1)
        expect(result.stderr).not.toContain("full-key")
      }),
    TIMEOUT,
  )

  test(
    "a rejected key registers nothing",
    () =>
      withSandbox({ baseURL: mock.url, apiKey: "wrong-key" }, async (box) => {
        const result = await box.run(["models"])
        expect(result.code).toBe(0)
        expect(modelsOf(result.stdout, "cliproxy")).toEqual([])
      }),
    TIMEOUT,
  )

  test(
    "a hanging endpoint is cut off by the timeout",
    () =>
      withSandbox({ baseURL: slow.url, apiKey: "full-key", timeout: 500 }, async (box) => {
        const started = Date.now()
        const result = await box.run(["models"])
        expect(result.code).toBe(0)
        expect(modelsOf(result.stdout, "cliproxy")).toEqual([])
        expect(Date.now() - started).toBeLessThan(8_000)
      }),
    TIMEOUT,
  )

  test(
    "the last good list is used while the endpoint is down",
    async () => {
      const flaky = startMock({ "full-key": LIMITED })
      const url = flaky.url
      await withSandbox({ baseURL: url, apiKey: "{env:CLIPROXY_TEST_KEY}" }, async (box) => {
        const up = await box.run(["models"], { CLIPROXY_TEST_KEY: "full-key" })
        expect(modelsOf(up.stdout, "cliproxy")).toEqual(ids(LIMITED))

        // A rejected key is not an outage: it must not resurrect the cached list.
        const rejected = await box.run(["models", "--print-logs", "--log-level", "warn"], { CLIPROXY_TEST_KEY: "wrong-key" })
        expect(modelsOf(rejected.stdout, "cliproxy")).toEqual([])
        expect(rejected.stderr).toContain("rejected the key (HTTP 401); no models registered")

        flaky.stop()
        const down = await box.run(["models", "--print-logs", "--log-level", "warn"], { CLIPROXY_TEST_KEY: "full-key" })
        expect(down.code).toBe(0)
        expect(modelsOf(down.stdout, "cliproxy")).toEqual(ids(LIMITED))
        expect(down.stderr).toContain("using the last good list")
      })
    },
    TIMEOUT,
  )
})

describe("opencode run", () => {
  const sessionHeaders = (headers: Record<string, string>) => ({
    session: headers["x-opencode-session"],
    sessionID: headers["x-opencode-session-id"],
    affinity: headers["x-session-affinity"],
  })

  const runAndInspect = async (options: Record<string, unknown>, model: string, path: string) =>
    withSandbox({ baseURL: mock.url, apiKey: "full-key", ...options }, async (box) => {
      const before = mock.requests.length
      const result = await box.run(["run", "--model", `cliproxy/${model}`, "--format", "json", "--title", "test", "say hi"])
      expect(result.code).toBe(0)
      const events = result.stdout
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line))
      expect(events.some((event) => event.type === "text" && event.part.text === REPLY)).toBe(true)
      const sessionID = events.find((event) => typeof event.sessionID === "string")?.sessionID
      expect(sessionID).toStartWith("ses_")

      const calls = mock.requests.slice(before).filter((request) => request.method === "POST")
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) {
        expect(call.path).toBe(path)
        expect(call.headers.authorization).toBe("Bearer full-key")
        expect(sessionHeaders(call.headers)).toEqual({ session: sessionID, sessionID, affinity: sessionID })
        expect(call.body).toMatchObject({ model })
      }
    })

  test("Chat Completions by default, with x-opencode-session set to the session id", () => runAndInspect({}, "local-model", "/v1/chat/completions"), TIMEOUT)

  test(
    "apiByOwner switches one owner's models to the Responses API",
    async () => {
      await runAndInspect({ apiByOwner: { openai: "responses" } }, "gpt-5", "/v1/responses")
      await runAndInspect({ apiByOwner: { openai: "responses" } }, "local-model", "/v1/chat/completions")
    },
    TIMEOUT * 2,
  )
})
