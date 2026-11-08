# opencode-cliproxy

An [OpenCode](https://opencode.ai) plugin that registers every model a
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) endpoint lists, under one provider.

OpenCode does not discover models for custom providers, so a custom provider normally needs a
hand-written `models` map. This plugin asks the endpoint instead: at startup it calls
`GET <baseURL>/models` with `Authorization: Bearer <key>` and registers what comes back. The key
decides what the endpoint lists, so OpenCode shows exactly the models that key may use.

Requires OpenCode 2.x; tested with 2.2.5.

## Install

The plugin is one self-contained file, [`src/cliproxy.ts`](src/cliproxy.ts). It imports only
`effect` and `@opencode/plugin/effect`, which OpenCode provides to plugins at runtime, so there is
nothing to install: no `git clone`, no `npm install`, no `node_modules`.

1. Put the file at `~/.config/opencode/plugins/cliproxy/index.ts`:

   ```sh
   mkdir -p ~/.config/opencode/plugins/cliproxy
   curl -fsSL https://raw.githubusercontent.com/danielphan2003/opencode-cliproxy/main/src/cliproxy.ts \
     -o ~/.config/opencode/plugins/cliproxy/index.ts
   ```

   A setup script that embeds the file can write it to the same path.

2. List it in `~/.config/opencode/opencode.json` with its options:

   ```json
   {
     "plugins": [
       {
         "package": "./plugins/cliproxy",
         "options": {
           "baseURL": "http://127.0.0.1:8317/v1",
           "apiKey": "{env:CLIPROXY_API_KEY}"
         }
       }
     ]
   }
   ```

3. Check it: `opencode models` lists the endpoint's models as `cliproxy/<model id>`.

Why a directory and not a bare `plugins/cliproxy.ts`: OpenCode passes `options` only to plugins
listed in `plugins`, and a listed local path must be a directory. A bare file in `plugins/` still
loads, but with no options. In that case the plugin reads `CLIPROXY_BASE_URL` and
`CLIPROXY_API_KEY` from the environment.

For one project only, use `.opencode/plugins/cliproxy/index.ts` and list `./plugins/cliproxy` in
`.opencode/opencode.json`; relative paths resolve from the config file that contains them.

## Options

All options are optional.

| Option           | Default                                              | Meaning                                                                                                   |
| ---------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `baseURL`        | `CLIPROXY_BASE_URL`, else `http://127.0.0.1:8317/v1` | The OpenAI-compatible base URL, including `/v1`. Models are read from `<baseURL>/models`.                 |
| `apiKey`         | `CLIPROXY_API_KEY`, else none                        | Sent as `Authorization: Bearer <key>` to `/models` and to every model request.                            |
| `providerID`     | `cliproxy`                                           | The provider id: models are `<providerID>/<model id>`.                                                    |
| `name`           | `CLIProxyAPI`                                        | The provider's display name.                                                                              |
| `include`        | all                                                  | Model id patterns to keep.                                                                                |
| `exclude`        | none                                                 | Model id patterns to drop.                                                                                |
| `includeOwnedBy` | all                                                  | `owned_by` patterns to keep.                                                                              |
| `excludeOwnedBy` | none                                                 | `owned_by` patterns to drop.                                                                              |
| `timeout`        | `5000`                                               | Milliseconds to wait for `/models` before giving up.                                                      |
| `api`            | `chat`                                               | Wire format for every model: `chat` or `responses`. See [Wire format](#wire-format).                      |
| `apiByOwner`     | `{}`                                                 | Wire format per `owned_by` value, e.g. `{ "openai": "responses" }`. Overrides `api`.                      |
| `enrich`         | `true`                                               | Copy names, limits and capabilities from OpenCode's model catalog. See [Model metadata](#model-metadata). |

Patterns are globs: `*` matches any run of characters and `?` matches one. Matching is
case-sensitive and covers the whole value, so `gpt-*` matches `gpt-5` but not `chatgpt-4o`. A model
is kept when it matches `include` (or `include` is empty) and does not match `exclude`, and the
same holds for its `owned_by` against `includeOwnedBy` and `excludeOwnedBy`. A model without
`owned_by` is matched as the empty string.

Example: only Claude and GPT models, without the mini variants.

```jsonc
"options": {
  "baseURL": "https://proxy.example.com/v1",
  "apiKey": "{file:~/.config/opencode/cliproxy.key}",
  "include": ["claude-*", "gpt-*"],
  "exclude": ["*-mini"]
}
```

### Keeping the key out of the config

OpenCode substitutes `{env:NAME}` and `{file:path}` in `opencode.json` before the plugin sees its
options; `{file:...}` resolves relative to the config file and accepts `~/`. Both are tested. The
plugin trims surrounding whitespace, so a key file may end with a newline. An unset variable
becomes an empty string, which the plugin treats as unset and falls back to `CLIPROXY_API_KEY`.

## Wire format

CLIProxyAPI accepts Chat Completions (`POST /chat/completions`) and the Responses API
(`POST /responses`) for every model it serves and translates to the upstream itself. The listing's
`owned_by` field names the upstream, not the format the endpoint expects, so the listing cannot
choose a format on its own.

The plugin therefore defaults every model to **Chat Completions**, through OpenCode's
`@opencode/ai/providers/openai-compatible` package. Set `api: "responses"` to use the Responses API
(`@opencode/ai/providers/openai-compatible-responses`) for all models, or `apiByOwner` to choose by
`owned_by`, for example `{ "openai": "responses" }` to send only OpenAI-owned models through
Responses.

## Model metadata

`/models` gives little more than ids. Each model gets:

- `display_name`, `context_length` and `max_completion_tokens` from the listing, when present (a
  `display_name` that only repeats the id counts as absent);
- otherwise, the name, limits and capabilities of the same model in OpenCode's built-in catalog
  (models.dev), preferring the provider named by `owned_by`. An id prefixed with its owner, as
  `opencode-go/gpt-6-luna` owned by `opencode-go`, also matches that provider's `gpt-6-luna`. Set
  `enrich: false` to skip the catalog;
- otherwise, OpenCode's defaults: a 200,000-token context and 32,000 output tokens.

**Reasoning efforts** become variants, one per effort, each setting only `reasoningEffort`: the
listing's `reasoning_efforts` when it sends one (skid does, for models whose efforts are set in its
config), else the variant names of the catalog model. The proxy translates the effort for whatever
serves the model, so the catalog's other variant settings, which belong to that provider's own API,
are not copied. Neither are costs.

## When the endpoint fails

OpenCode always starts. Discovery runs once, at plugin load, and waits at most `timeout`. On
failure the plugin logs one warning, without the key, and:

- **unreachable** (connection error, timeout, HTTP 5xx): registers the last list it fetched
  successfully from the same `baseURL`, if any, kept in the plugin's OpenCode storage; otherwise
  nothing;
- **rejected** (HTTP 4xx, such as a wrong key): registers nothing;
- **unusable answer** (not a model list): registers nothing.

The list is fetched only at startup; restart OpenCode to pick up models added later.

## Session headers

OpenCode 2.2.5 sends `x-opencode-session`, `x-opencode-session-id` and `x-session-affinity` with
the session id on every model request, including to this plugin's provider. The tests check this
with a real `opencode run` against the mock endpoint, for both wire formats, so the plugin adds no
headers of its own.

## Development

```sh
bun install       # dev-only tooling; also installs the pre-commit hook
bun run check     # format check and lint, typecheck, then all tests
bun run fmt       # format everything
```

Formatting and linting use [Vite+](https://viteplus.dev) (Oxfmt and Oxlint), configured in
`vite.config.ts` after [T3 Code](https://github.com/pingdotgg/t3code)'s settings. The pre-commit
hook in `.vite-hooks/` formats and lints staged files. CI runs the lint, typecheck and test jobs on
every pull request, the tests against OpenCode 2.2.5.

The tests need `opencode` on `PATH`.

- `test/unit.test.ts` covers option handling, filtering, model construction, and fetching from a
  mock endpoint, including a rejected key, a refused connection, a 5xx, an HTML page and a timeout.
- `test/opencode.test.ts` runs the real `opencode` binary with the plugin vendored as described
  above, against `test/mock-server.ts`. It covers discovery per key, `{env:}` and `{file:}` keys,
  filters, an unreachable, rejected and hanging endpoint, the cached list, and `opencode run`
  through both wire formats with the session headers checked on each request.

Each test runs OpenCode with `--standalone` in a temporary `HOME`, so the tests never touch your
own OpenCode configuration or a running OpenCode service.

## License

[MIT](LICENSE)
