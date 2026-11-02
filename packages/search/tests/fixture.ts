import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  json: unknown;
}

export interface FixtureResponse {
  status?: number;
  body: unknown;
}

export type FixtureRoute = (request: FixtureRequest) => FixtureResponse | Promise<FixtureResponse>;

export interface Fixture {
  url: string;
  requests: FixtureRequest[];
  close(): Promise<void>;
}

export async function startFixture(routes: Record<string, FixtureRoute>): Promise<Fixture> {
  const requests: FixtureRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url ?? "/", "http://fixture.local");
    const recorded: FixtureRequest = {
      method: request.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: request.headers,
      json: raw.length > 0 ? JSON.parse(raw) : undefined,
    };
    requests.push(recorded);
    const route = routes[url.pathname];
    if (!route) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const result = await route(recorded);
    response.writeHead(result.status ?? 200, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      return closed.promise;
    },
  };
}
