/**
 * opencode-cliproxy: registers every model a CLIProxyAPI endpoint lists as one OpenCode provider.
 *
 * Self-contained by design: it imports only `effect` and `@opencode/plugin/effect`, which OpenCode
 * provides to plugins at runtime, so this one file can be copied into OpenCode's plugin directory
 * as `plugins/cliproxy/index.ts` without installing anything. See README.md for options.
 */
import { Model, Plugin, Provider } from "@opencode/plugin/effect";
import { Cause, Config, Duration, Effect, Option, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

// ---------------------------------------------------------------------------------------------
// Options

/** `chat` speaks Chat Completions (`POST /chat/completions`); `responses` speaks the Responses API. */
export const Api = Schema.Literals(["chat", "responses"]);
export type Api = typeof Api.Type;

const Patterns = Schema.Array(Schema.String);

/** Plugin options as written in `opencode.json`. Every field is optional. */
export const Options = Schema.Struct({
  baseURL: Schema.optional(Schema.String),
  apiKey: Schema.optional(Schema.String),
  providerID: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  include: Schema.optional(Patterns),
  exclude: Schema.optional(Patterns),
  includeOwnedBy: Schema.optional(Patterns),
  excludeOwnedBy: Schema.optional(Patterns),
  timeout: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
  api: Schema.optional(Api),
  apiByOwner: Schema.optional(Schema.Record(Schema.String, Api)),
  enrich: Schema.optional(Schema.Boolean),
});
export interface Options extends Schema.Schema.Type<typeof Options> {}

export const DEFAULTS = {
  baseURL: "http://127.0.0.1:8317/v1",
  providerID: "cliproxy",
  name: "CLIProxyAPI",
  timeout: 5000,
  api: "chat",
} as const;

/** Options with defaults applied and the key resolved. */
export interface Settings {
  readonly baseURL: string;
  readonly apiKey: string | undefined;
  readonly providerID: string;
  readonly name: string;
  readonly include: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
  readonly includeOwnedBy: ReadonlyArray<string>;
  readonly excludeOwnedBy: ReadonlyArray<string>;
  readonly timeout: number;
  readonly api: Api;
  readonly apiByOwner: Readonly<Record<string, Api>>;
  readonly enrich: boolean;
}

/** Empty strings count as unset, so a `{env:VAR}` whose variable is missing falls through to the default. */
const present = (value: string | undefined) =>
  value === undefined || value.trim() === "" ? undefined : value.trim();

export const settingsFrom = (
  options: Options,
  env: { readonly baseURL?: string; readonly apiKey?: string } = {},
): Settings => ({
  baseURL: (present(options.baseURL) ?? present(env.baseURL) ?? DEFAULTS.baseURL).replace(
    /\/+$/,
    "",
  ),
  apiKey: present(options.apiKey) ?? present(env.apiKey),
  providerID: present(options.providerID) ?? DEFAULTS.providerID,
  name: present(options.name) ?? DEFAULTS.name,
  include: options.include ?? [],
  exclude: options.exclude ?? [],
  includeOwnedBy: options.includeOwnedBy ?? [],
  excludeOwnedBy: options.excludeOwnedBy ?? [],
  timeout: options.timeout ?? DEFAULTS.timeout,
  api: options.api ?? DEFAULTS.api,
  apiByOwner: options.apiByOwner ?? {},
  enrich: options.enrich ?? true,
});

// ---------------------------------------------------------------------------------------------
// The listing

/**
 * One entry of `GET /models`. CLIProxyAPI sends `id`, `object`, `created` and `owned_by`; the rest
 * is read if present. skid also sends the name, limits and, for models whose efforts are set in its
 * config or listed in OpenCode Go's catalog, `reasoning_efforts`.
 */
export const ListedModel = Schema.Struct({
  id: Schema.String,
  owned_by: Schema.optional(Schema.NullOr(Schema.String)),
  created: Schema.optional(Schema.NullOr(Schema.Finite)),
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  context_length: Schema.optional(Schema.NullOr(Schema.Int)),
  max_completion_tokens: Schema.optional(Schema.NullOr(Schema.Int)),
  reasoning_efforts: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});
export interface ListedModel extends Schema.Schema.Type<typeof ListedModel> {}

export const Listing = Schema.Struct({ data: Schema.Array(ListedModel) });

/** The last good listing, kept in plugin storage as a JSON string for when the endpoint is unreachable. */
const Cached = Schema.fromJsonString(
  Schema.Struct({ baseURL: Schema.String, models: Schema.Array(ListedModel) }),
);

/**
 * Why discovery failed. Only `unreachable` (transport error, timeout, 5xx) falls back to the cached list:
 * a rejected key or a response that is not a model list registers nothing.
 */
export const FailureReason = Schema.Literals(["unreachable", "rejected", "invalid"]);

export class DiscoveryError extends Schema.TaggedError<DiscoveryError>()("DiscoveryError", {
  url: Schema.String,
  reason: FailureReason,
  message: Schema.String,
}) {}

const classify = (
  cause: HttpClientError.HttpClientError | Schema.SchemaError | Cause.TimeoutError,
  settings: Settings,
): Pick<DiscoveryError, "reason" | "message"> => {
  if (Cause.isTimeoutError(cause))
    return { reason: "unreachable", message: `no answer within ${settings.timeout} ms` };
  if (Schema.isSchemaError(cause))
    return { reason: "invalid", message: "the response is not a model list" };
  const reason = cause.reason;
  if (reason._tag === "StatusCodeError") {
    const status = reason.response.status;
    return { reason: status >= 500 ? "unreachable" : "rejected", message: `HTTP ${status}` };
  }
  return {
    reason: reason._tag === "TransportError" ? "unreachable" : "invalid",
    message: cause.message,
  };
};

/** Fetches and decodes `GET <baseURL>/models`, failing with `DiscoveryError` on any transport, status, decode or timeout problem. */
export const fetchListing = Effect.fn("cliproxy.fetchListing")(function* (settings: Settings) {
  const url = `${settings.baseURL}/models`;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const request = HttpClientRequest.get(url).pipe(
    HttpClientRequest.acceptJson,
    settings.apiKey === undefined ? (self) => self : HttpClientRequest.bearerToken(settings.apiKey),
  );
  const listing = yield* client.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Listing)),
    Effect.timeout(Duration.millis(settings.timeout)),
    Effect.mapError((cause) => new DiscoveryError({ url, ...classify(cause, settings) })),
  );
  return listing.data;
}, Effect.provide(FetchHttpClient.layer));

// ---------------------------------------------------------------------------------------------
// Filtering and model construction

const globToRegExp = (glob: string) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );

/** `*` matches any run of characters and `?` one character; matching is case-sensitive and anchored. */
export const matchesAny = (patterns: ReadonlyArray<string>, value: string) =>
  patterns.some((pattern) => globToRegExp(pattern).test(value));

/** An empty include list admits everything; exclude always wins. A model without `owned_by` is matched as "". */
export const admits = (settings: Settings, model: ListedModel) => {
  const owner = model.owned_by ?? "";
  if (settings.include.length > 0 && !matchesAny(settings.include, model.id)) return false;
  if (matchesAny(settings.exclude, model.id)) return false;
  if (settings.includeOwnedBy.length > 0 && !matchesAny(settings.includeOwnedBy, owner))
    return false;
  if (matchesAny(settings.excludeOwnedBy, owner)) return false;
  return true;
};

export const PACKAGES: Record<Api, string> = {
  chat: "@opencode/ai/providers/openai-compatible",
  responses: "@opencode/ai/providers/openai-compatible-responses",
};

export const apiFor = (settings: Settings, model: ListedModel): Api =>
  (model.owned_by ? settings.apiByOwner[model.owned_by] : undefined) ?? settings.api;

/** Builds the OpenCode model for one listed entry. `known` is the same model id from OpenCode's catalog, if any. */
export const toModel = (
  settings: Settings,
  listed: ListedModel,
  known?: Model.Info,
): Model.Info => {
  const providerID = Provider.ID.make(settings.providerID);
  const base = Model.Info.default(providerID, Model.ID.make(listed.id));
  const api = apiFor(settings, listed);
  // A listed name that only repeats the id, with or without its owner prefix, says nothing; the
  // catalog's is better.
  const listedName = present(listed.display_name ?? undefined);
  const prefix = listed.owned_by ? `${listed.owned_by}/` : undefined;
  const bareID =
    prefix && listed.id.startsWith(prefix) ? listed.id.slice(prefix.length) : listed.id;
  const namesNothing = listedName === listed.id || listedName === bareID;
  return {
    ...base,
    name: (namesNothing ? undefined : listedName) ?? known?.name ?? listed.id,
    ...(known?.family === undefined ? {} : { family: known.family }),
    ...(api === settings.api ? {} : { package: PACKAGES[api] }),
    capabilities: known?.capabilities ?? base.capabilities,
    time: {
      released: listed.created
        ? listed.created * 1000
        : (known?.time.released ?? base.time.released),
    },
    limit: {
      context: listed.context_length ?? known?.limit.context ?? base.limit.context,
      output: listed.max_completion_tokens ?? known?.limit.output ?? base.limit.output,
      ...(known?.limit.input === undefined ? {} : { input: known.limit.input }),
    },
    variants: variantsFor(listed, known),
  };
};

/**
 * One variant per reasoning effort: the endpoint's own list when it sends one, else the catalog
 * model's variant ids. Each sets only `reasoningEffort`, which the endpoint maps onto whatever
 * serves the model, so settings meant for another provider's wire format are not copied. A catalog
 * effort the endpoint does not support for that model may be lowered or rejected by it.
 */
export const variantsFor = (listed: ListedModel, known?: Model.Info): Model.Info["variants"] => {
  const efforts = listed.reasoning_efforts ?? known?.variants.map((variant) => variant.id) ?? [];
  return [...new Set(efforts.map((effort) => effort.trim()).filter((effort) => effort !== ""))].map(
    (effort) => ({ id: Model.VariantID.make(effort), settings: { reasoningEffort: effort } }),
  );
};

/** Finds `modelID` in OpenCode's catalog, preferring the provider named by `owned_by`. */
export const findKnown = (
  records: ReadonlyArray<{
    readonly provider: Provider.Info;
    readonly models: ReadonlyMap<string, Model.Info>;
  }>,
  listed: ListedModel,
  ownProviderID: string,
) => {
  const candidates = records.filter((record) => record.provider.id !== ownProviderID);
  const owner = candidates.find((record) => record.provider.id === listed.owned_by);
  // An endpoint that prefixes a provider's models (`opencode-go/gpt-6-luna`) lists them under
  // that provider as owner; OpenCode's catalog knows them without the prefix.
  const prefix = listed.owned_by ? `${listed.owned_by}/` : undefined;
  const unprefixed =
    prefix && listed.id.startsWith(prefix) ? listed.id.slice(prefix.length) : undefined;
  return (
    owner?.models.get(listed.id) ??
    (unprefixed === undefined ? undefined : owner?.models.get(unprefixed)) ??
    candidates.map((record) => record.models.get(listed.id)).find((model) => model !== undefined)
  );
};

export const providerInfo = (settings: Settings): Provider.Info => ({
  ...Provider.Info.empty(Provider.ID.make(settings.providerID)),
  name: settings.name,
  activation: "enabled",
  package: PACKAGES[settings.api],
  settings: {
    baseURL: settings.baseURL,
    ...(settings.apiKey === undefined ? {} : { apiKey: settings.apiKey }),
  },
});

// ---------------------------------------------------------------------------------------------
// The plugin

const cacheKey = (settings: Settings) => `listing:${settings.providerID}`;

export default Plugin.define({
  id: "cliproxy",
  effect: Effect.fn("cliproxy")(function* (ctx) {
    const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        Effect.logWarning(
          `cliproxy: invalid plugin options, no models registered: ${error.message}`,
        ).pipe(Effect.as(Option.none<Options>())),
      ),
    );
    if (Option.isNone(options)) return;
    const env = yield* Config.all({
      baseURL: Config.String("CLIPROXY_BASE_URL").pipe(Config.option),
      apiKey: Config.String("CLIPROXY_API_KEY").pipe(Config.option),
    }).pipe(
      Effect.orElseSucceed(() => ({
        baseURL: Option.none<string>(),
        apiKey: Option.none<string>(),
      })),
    );
    const settings = settingsFrom(options.value, {
      baseURL: Option.getOrUndefined(env.baseURL),
      apiKey: Option.getOrUndefined(env.apiKey),
    });

    const listed = yield* fetchListing(settings).pipe(
      Effect.tap((models) =>
        ctx.storage.set(cacheKey(settings), JSON.stringify({ baseURL: settings.baseURL, models })),
      ),
      Effect.catch(
        Effect.fnUntraced(function* (error) {
          const problem = `cliproxy: ${error.url} ${error.reason === "rejected" ? "rejected the key" : error.reason === "invalid" ? "gave an unusable answer" : "is unavailable"} (${error.message})`;
          if (error.reason === "unreachable") {
            const cached = yield* ctx.storage.get(cacheKey(settings)).pipe(
              Effect.flatMap((value) => Schema.decodeUnknownEffect(Cached)(value)),
              Effect.option,
              Effect.map(Option.filter((entry) => entry.baseURL === settings.baseURL)),
            );
            if (Option.isSome(cached)) {
              yield* Effect.logWarning(
                `${problem}; using the last good list of ${cached.value.models.length} models.`,
              );
              return cached.value.models;
            }
          }
          yield* Effect.logWarning(`${problem}; no models registered.`);
          return [];
        }),
      ),
    );

    const admitted = listed.filter((model) => admits(settings, model));
    if (admitted.length === 0) return;

    yield* ctx.provider.transform((editor) => {
      const catalog = settings.enrich ? editor.list() : [];
      editor.add({
        info: providerInfo(settings),
        models: admitted.map((model) =>
          toModel(settings, model, findKnown(catalog, model, settings.providerID)),
        ),
      });
    });
  }),
});
