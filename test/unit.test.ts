import { afterAll, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Option, Schema } from "effect"
import {
  admits,
  apiFor,
  DEFAULTS,
  DiscoveryError,
  fetchListing,
  findKnown,
  matchesAny,
  Options,
  PACKAGES,
  providerInfo,
  settingsFrom,
  toModel,
  type ListedModel,
} from "../src/cliproxy.ts"
import { startMock } from "./mock-server.ts"

const listed = (id: string, owned_by?: string): ListedModel => ({ id, owned_by })

describe("options", () => {
  test("defaults apply when nothing is set", () => {
    const settings = settingsFrom({})
    expect(settings).toMatchObject({ ...DEFAULTS, apiKey: undefined, enrich: true })
  })

  test("empty strings, as left by a {env:VAR} whose variable is unset, fall through", () => {
    const settings = settingsFrom({ baseURL: "", apiKey: "  " }, { baseURL: "http://env/v1/", apiKey: "from-env" })
    expect(settings.baseURL).toBe("http://env/v1")
    expect(settings.apiKey).toBe("from-env")
  })

  test("options win over the environment", () => {
    const settings = settingsFrom({ baseURL: "http://opt/v1", apiKey: "opt" }, { baseURL: "http://env/v1", apiKey: "env" })
    expect(settings).toMatchObject({ baseURL: "http://opt/v1", apiKey: "opt" })
  })

  test("invalid options are rejected by the schema", () => {
    const decode = Schema.decodeUnknownExit(Options)
    expect(Exit.isFailure(decode({ timeout: -1 }))).toBe(true)
    expect(Exit.isFailure(decode({ api: "anthropic" }))).toBe(true)
    expect(Exit.isFailure(decode({ include: "gpt-*" }))).toBe(true)
    expect(Exit.isSuccess(decode({ include: ["gpt-*"], apiByOwner: { openai: "responses" } }))).toBe(true)
  })
})

describe("filtering", () => {
  test("globs are anchored and treat regex characters literally", () => {
    expect(matchesAny(["gpt-*"], "gpt-5")).toBe(true)
    expect(matchesAny(["gpt-*"], "chatgpt-5")).toBe(false)
    expect(matchesAny(["gpt-5.?"], "gpt-5.1")).toBe(true)
    expect(matchesAny(["gpt-5.1"], "gpt-5x1")).toBe(false)
    expect(matchesAny([], "anything")).toBe(false)
  })

  const models = [listed("gpt-5", "openai"), listed("gpt-5-mini", "openai"), listed("claude-sonnet-4-5", "anthropic"), listed("local")]
  const ids = (options: Options) => models.filter((model) => admits(settingsFrom(options), model)).map((model) => model.id)

  test("no filter admits everything", () => expect(ids({})).toEqual(models.map((model) => model.id)))
  test("include on ids", () => expect(ids({ include: ["gpt-*"] })).toEqual(["gpt-5", "gpt-5-mini"]))
  test("exclude wins over include", () => expect(ids({ include: ["gpt-*"], exclude: ["*-mini"] })).toEqual(["gpt-5"]))
  test("include on owned_by", () => expect(ids({ includeOwnedBy: ["anthropic"] })).toEqual(["claude-sonnet-4-5"]))
  test("exclude on owned_by", () => expect(ids({ excludeOwnedBy: ["openai"] })).toEqual(["claude-sonnet-4-5", "local"]))
  test("a missing owned_by matches as the empty string", () => expect(ids({ excludeOwnedBy: [""] })).toHaveLength(3))
})

describe("models", () => {
  test("the wire format follows apiByOwner, else api", () => {
    const settings = settingsFrom({ apiByOwner: { openai: "responses" } })
    expect(apiFor(settings, listed("gpt-5", "openai"))).toBe("responses")
    expect(apiFor(settings, listed("claude", "anthropic"))).toBe("chat")
  })

  test("a model only names its own package when it differs from the provider's", () => {
    const settings = settingsFrom({ apiByOwner: { openai: "responses" } })
    expect(toModel(settings, listed("gpt-5", "openai")).package).toBe(PACKAGES.responses)
    expect(toModel(settings, listed("claude", "anthropic")).package).toBeUndefined()
    expect(providerInfo(settings).package).toBe(PACKAGES.chat)
  })

  test("listing metadata wins, then the catalog, then OpenCode's defaults", () => {
    const settings = settingsFrom({})
    const bare = toModel(settings, listed("x"))
    expect(bare).toMatchObject({ id: "x", providerID: "cliproxy", name: "x", limit: { context: 200_000, output: 32_000 } })

    const known = { ...bare, name: "Known X", limit: { context: 1_000_000, output: 64_000 } }
    expect(toModel(settings, listed("x"), known)).toMatchObject({ name: "Known X", limit: { context: 1_000_000, output: 64_000 } })

    const rich = { ...listed("x"), display_name: "Listed X", context_length: 128_000, max_completion_tokens: 8_000, created: 1_700_000_000 }
    expect(toModel(settings, rich, known)).toMatchObject({
      name: "Listed X",
      limit: { context: 128_000, output: 8_000 },
      time: { released: 1_700_000_000_000 },
    })
  })

  test("the catalog lookup prefers the provider named by owned_by and skips our own provider", () => {
    const record = (id: string, name: string) => {
      const settings = settingsFrom({ providerID: id })
      return { provider: providerInfo(settings), models: new Map([["m", { ...toModel(settings, listed("m")), name }]]) }
    }
    const records = [record("cliproxy", "ours"), record("other", "other"), record("acme", "acme")]
    expect(findKnown(records, listed("m", "acme"), "cliproxy")?.name).toBe("acme")
    expect(findKnown(records, listed("m", "nobody"), "cliproxy")?.name).toBe("other")
    expect(findKnown(records.slice(0, 1), listed("m"), "cliproxy")).toBeUndefined()
  })

  test("the provider carries the base URL and key as provider settings", () => {
    expect(providerInfo(settingsFrom({ baseURL: "http://h/v1", apiKey: "k", name: "N" }))).toMatchObject({
      id: "cliproxy",
      name: "N",
      activation: "enabled",
      settings: { baseURL: "http://h/v1", apiKey: "k" },
    })
    expect(providerInfo(settingsFrom({})).settings).toEqual({ baseURL: DEFAULTS.baseURL })
  })
})

describe("fetchListing", () => {
  const mock = startMock({ good: [{ id: "a", owned_by: "openai" }, { id: "b" }] })
  const slow = startMock({ good: [{ id: "a" }] }, { modelsDelayMs: 2_000 })
  const oddServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname.startsWith("/error")
        ? new Response("upstream down", { status: 502 })
        : new Response("<html>not an API</html>", { headers: { "content-type": "text/html" } }),
  })
  const odd = { url: `http://127.0.0.1:${oddServer.port}` }
  afterAll(() => {
    mock.stop()
    slow.stop()
    oddServer.stop(true)
  })

  const run = (options: Options) => Effect.runPromiseExit(fetchListing(settingsFrom(options)))

  test("returns the listing for the key", async () => {
    const exit = await run({ baseURL: mock.url, apiKey: "good" })
    expect(Exit.isSuccess(exit) && exit.value.map((model) => model.id)).toEqual(["a", "b"])
    expect(mock.requests.at(-1)?.headers.authorization).toBe("Bearer good")
  })

  const reasonOf = async (options: Options) => {
    const exit = await run(options)
    if (Exit.isSuccess(exit)) return "success"
    const error = Cause.findErrorOption(exit.cause)
    return Option.isSome(error) && error.value instanceof DiscoveryError ? error.value.reason : "other"
  }

  test("a rejected key is rejected", async () => expect(await reasonOf({ baseURL: mock.url, apiKey: "bad" })).toBe("rejected"))
  test("a refused connection is unreachable", async () => expect(await reasonOf({ baseURL: "http://127.0.0.1:9/v1" })).toBe("unreachable"))
  test("a 5xx is unreachable", async () => expect(await reasonOf({ baseURL: `${odd.url}/error` })).toBe("unreachable"))
  test("a page that is not a model list is invalid", async () => expect(await reasonOf({ baseURL: `${odd.url}/html` })).toBe("invalid"))

  test("a slow endpoint times out", async () => {
    const started = Date.now()
    const exit = await run({ baseURL: slow.url, apiKey: "good", timeout: 200 })
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_500)
  })
})
