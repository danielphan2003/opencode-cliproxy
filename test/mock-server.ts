// A stand-in for CLIProxyAPI: lists models per key at GET /v1/models and answers
// Chat Completions and Responses requests with a fixed streamed reply.

export interface MockModel {
  readonly id: string;
  readonly owned_by?: string;
  readonly created?: number;
  readonly [extra: string]: unknown;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export const REPLY = "pong from mock";

const sse = (events: ReadonlyArray<unknown>) =>
  new Response(
    events
      .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
      .join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );

const chatStream = (model: string) => {
  const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model };
  return sse([
    {
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: REPLY }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
    "[DONE]",
  ]);
};

const responsesStream = (model: string) => {
  const item = {
    id: "msg_mock",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: REPLY, annotations: [] }],
  };
  const response = {
    id: "resp_mock",
    object: "response",
    created_at: 0,
    model,
    status: "in_progress",
    output: [] as unknown[],
  };
  return sse([
    { type: "response.created", sequence_number: 0, response },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 2,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: REPLY,
    },
    { type: "response.output_item.done", sequence_number: 3, output_index: 0, item },
    {
      type: "response.completed",
      sequence_number: 4,
      response: {
        ...response,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
};

/** `keys` maps each accepted bearer key to the models it may see. */
export const startMock = (
  keys: Record<string, ReadonlyArray<MockModel>>,
  options: { readonly modelsDelayMs?: number } = {},
) => {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      requests.push({
        method: request.method,
        path: url.pathname,
        headers: Object.fromEntries(request.headers),
        body: text ? JSON.parse(text) : undefined,
      });
      const key = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const models = keys[key];
      if (!models) return Response.json({ error: { message: "Invalid API key" } }, { status: 401 });

      if (request.method === "GET" && url.pathname === "/v1/models") {
        if (options.modelsDelayMs) await Bun.sleep(options.modelsDelayMs);
        return Response.json({
          object: "list",
          data: models.map((model) => ({ object: "model", created: 0, ...model })),
        });
      }
      const body = text ? JSON.parse(text) : {};
      if (request.method === "POST" && url.pathname === "/v1/chat/completions")
        return chatStream(body.model);
      if (request.method === "POST" && url.pathname === "/v1/responses")
        return responsesStream(body.model);
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
};
