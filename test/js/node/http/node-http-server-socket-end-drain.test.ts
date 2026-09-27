import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, tls as tlsCert } from "harness";
import { once } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

// res.socket.end() half-closes the connection; the server must still release the
// socket (drain the unconsumed body on epoll, or take kqueue's EVFILT_WRITE
// EV_EOF from its own SHUT_WR) so server.close() resolves. On macOS that early
// close can RST the still-writing client, so the client's EPIPE is expected and
// the close wait must not be once(c, "close"), which would reject on it.
test("server.close() completes after res.socket.end() with a 2 MB upload in flight", async () => {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `
        import { once } from "node:events";
        import http from "node:http";
        import net from "node:net";
        let sock;
        const handled = Promise.withResolvers();
        const server = http.createServer((req, res) => {
          res.writeHead(200, { Connection: "close" });
          sock = res.socket;
          res.socket.end();
          try { res.write("x"); } catch {}
          handled.resolve();
        });
        await once(server.listen(0, "127.0.0.1"), "listening");
        const port = server.address().port;
        const c = net.connect(port, "127.0.0.1");
        await once(c, "connect");
        const body = Buffer.alloc(2 * 1024 * 1024, 0x61);
        c.on("error", () => {});
        c.write("POST / HTTP/1.1\\r\\nHost: x\\r\\nContent-Length: " + body.length + "\\r\\nConnection: close\\r\\n\\r\\n");
        c.write(body);
        c.on("end", () => c.end());
        // Not once(c, "close"): that also registers an 'error' rejector, and on
        // macOS the 2 MB upload can hit EPIPE once the server's SHUT_WR +
        // resume drains the body. The write error is expected (and swallowed
        // above); rejecting socketClosed on it turned it into an uncaught
        // top-level rejection instead of exercising the drain/close path.
        const socketClosed = new Promise(r => c.once("close", r));
        await handled.promise;
        const serverClosed = new Promise(r => server.close(() => r()));
        const watchdog = setTimeout(() => {
          process.stdout.write("timeout destroyed=" + (sock?.destroyed ?? "none") + "\\n");
          process.exit(1);
        }, 10000);
        await Promise.all([socketClosed, serverClosed]);
        clearTimeout(watchdog);
        process.stdout.write("closed destroyed=" + sock.destroyed + "\\n");
      `,
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ stdout, stderr, exitCode }).toEqual({ stdout: "closed destroyed=true\n", stderr: "", exitCode: 0 });
});

// In Node the response and the raw socket share one net.Socket Writable, so the
// FIN of socket.end() / destroySoon() follows every byte the response wrote.
describe.each(["http", "https"] as const)("%s: the raw socket's FIN follows the bytes the response wrote", protocol => {
  type Handler = (req: IncomingMessage, res: ServerResponse) => void;
  const cases: [string, Handler, string][] = [
    [
      "res.write() then req.socket.destroySoon()",
      (req, res) => {
        res.write("PART1");
        req.socket.destroySoon();
      },
      "5\r\nPART1\r\n",
    ],
    [
      "res.write() then res.socket.end()",
      (req, res) => {
        res.write("PART1");
        res.socket!.end();
      },
      "5\r\nPART1\r\n",
    ],
    [
      "res.write() then res.socket.end() from a microtask",
      (req, res) => {
        res.write("PART1");
        queueMicrotask(() => res.socket!.end());
      },
      "5\r\nPART1\r\n",
    ],
    [
      "res.flushHeaders() then res.socket.end()",
      (req, res) => {
        res.flushHeaders();
        res.socket!.end();
      },
      "",
    ],
  ];

  test.concurrent.each(cases)("%s", async (_name, respond, body) => {
    const onRequest: Handler = (req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      respond(req, res);
    };
    await using server = protocol === "https" ? https.createServer(tlsCert, onRequest) : http.createServer(onRequest);
    await once(server.listen(0, "127.0.0.1"), "listening");
    const { port } = server.address() as net.AddressInfo;

    const client =
      protocol === "https"
        ? tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false })
        : net.connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    client.on("data", chunk => chunks.push(chunk));
    // The server can close before the client's own FIN lands; only the bytes matter here.
    client.on("error", () => {});
    const closed = new Promise(resolve => client.once("close", resolve));
    client.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    await closed;

    const received = Buffer.concat(chunks).toString("latin1");
    const headEnd = received.indexOf("\r\n\r\n");
    expect({
      statusLine: received.slice(0, received.indexOf("\r\n")),
      body: headEnd === -1 ? null : received.slice(headEnd + 4),
    }).toEqual({ statusLine: "HTTP/1.1 200 OK", body });
  });

  // socket.end() runs while the transport still holds bytes (8 MB is more than the
  // loopback socket buffers absorb), and the response never ends. Node sends the
  // FIN behind those bytes and keeps the connection until the peer has ended too.
  describe("socket.end() behind bytes that the transport still holds", () => {
    const TOTAL = 8 * 1024 * 1024;
    const request = (path: string) => `GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`;
    // What res.write() puts on the wire for `count` chunks of `size` bytes. No res.end(), so no last chunk.
    const chunked = (size: number, count = TOTAL / size) =>
      Buffer.concat(
        new Array(count).fill(
          Buffer.concat([Buffer.from(size.toString(16) + "\r\n"), Buffer.alloc(size, "a"), Buffer.from("\r\n")]),
        ),
      );
    const writeChunks = (res: ServerResponse, size: number) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      const chunk = Buffer.alloc(size, "a");
      for (let i = 0; i < TOTAL / size; i++) res.write(chunk);
    };

    type Scenario = {
      name: string;
      // Handles the request to /end.
      respond: Handler;
      // The bytes between the last response head and the FIN.
      body: () => Buffer;
      statusLines?: string[];
      send?: (client: net.Socket) => void;
      httpAllowHalfOpen?: boolean;
    };
    const scenarios: Scenario[] = [
      {
        name: "res.write() in 16 KB chunks, res.socket.end()",
        respond(req, res) {
          writeChunks(res, 16 * 1024);
          res.socket!.end();
        },
        body: () => chunked(16 * 1024),
      },
      {
        name: "res.write() in 1 MB chunks, res.socket.end()",
        respond(req, res) {
          writeChunks(res, 1024 * 1024);
          res.socket!.end();
        },
        body: () => chunked(1024 * 1024),
      },
      {
        name: "req.socket.end(data) and no response",
        respond(req) {
          req.socket.end(Buffer.alloc(TOTAL, "a"));
        },
        body: () => Buffer.alloc(TOTAL, "a"),
        statusLines: [],
      },
      {
        name: "res.write(), req.socket.end(data)",
        respond(req, res) {
          writeChunks(res, 1024 * 1024);
          req.socket.end("RAW");
        },
        body: () => Buffer.concat([chunked(1024 * 1024), Buffer.from("RAW")]),
      },
      {
        name: "res.write(), res.socket.end() from setImmediate",
        respond(req, res) {
          writeChunks(res, 1024 * 1024);
          setImmediate(() => res.socket!.end());
        },
        body: () => chunked(1024 * 1024),
      },
      {
        name: "the second request of a keep-alive connection",
        respond(req, res) {
          writeChunks(res, 1024 * 1024);
          res.socket!.end();
        },
        body: () => chunked(1024 * 1024),
        statusLines: ["HTTP/1.1 200 OK", "HTTP/1.1 200 OK"],
        send(client) {
          let first = "";
          const onData = (data: Buffer) => {
            first += data.toString("latin1");
            if (!first.endsWith("\r\n\r\nok")) return;
            client.off("data", onData);
            client.write(request("/end"));
          };
          client.on("data", onData);
          client.write(request("/first"));
        },
      },
      {
        name: "the first of two pipelined requests",
        respond(req, res) {
          writeChunks(res, 1024 * 1024);
          res.socket!.end();
        },
        body: () => chunked(1024 * 1024),
        send: client => void client.write(request("/end") + request("/after")),
      },
      {
        name: "httpAllowHalfOpen and a client that ended first",
        respond(req, res) {
          writeChunks(res, 1024 * 1024);
          res.socket!.end();
        },
        body: () => chunked(1024 * 1024),
        send: client => void client.end(request("/end")),
        httpAllowHalfOpen: true,
      },
    ];

    test.concurrent.each(scenarios)(
      "$name",
      async ({ respond, body: expectedBody, statusLines = ["HTTP/1.1 200 OK"], send, httpAllowHalfOpen = false }) => {
        const { promise: serverSocketClosed, resolve: onServerSocketClose } = Promise.withResolvers<void>();
        let serverSocket: net.Socket | undefined;
        const onRequest: Handler = (req, res) => {
          if (req.url === "/first") return void res.end("ok");
          // Behind a response that never ends: it gets no turn.
          if (req.url === "/after") return;
          serverSocket = req.socket;
          serverSocket.on("close", onServerSocketClose);
          respond(req, res);
        };
        await using server =
          protocol === "https" ? https.createServer(tlsCert, onRequest) : http.createServer(onRequest);
        server.httpAllowHalfOpen = httpAllowHalfOpen;
        await once(server.listen(0, "127.0.0.1"), "listening");
        const { port } = server.address() as net.AddressInfo;

        // allowHalfOpen: the FIN of the server does not make the client send its own.
        const client =
          protocol === "https"
            ? tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false, allowHalfOpen: true })
            : net.connect({ port, host: "127.0.0.1", allowHalfOpen: true });
        try {
          const received: Buffer[] = [];
          const ended = new Promise<void>((resolve, reject) => {
            client.on("data", data => received.push(data));
            client.on("end", resolve);
            client.on("error", reject);
          });
          if (send) send(client);
          else client.write(request("/end"));
          await ended;

          const clientEndedFirst = client.writableEnded;
          const response = Buffer.concat(received);
          const body = expectedBody();
          const bodyStart = Math.max(0, response.length - body.length);
          expect({
            statusLines:
              response
                .subarray(0, bodyStart)
                .toString("latin1")
                .match(/HTTP\/1\.1 [^\r\n]*/g) ?? [],
            bodyStart: response.subarray(Math.max(0, bodyStart - 4), bodyStart).toString("latin1"),
            bodyLength: response.length - bodyStart,
            bodyMatches: response.subarray(bodyStart).equals(body),
            // With the client's FIN still to come, the server keeps the socket.
            serverSocketDestroyed: clientEndedFirst ? undefined : serverSocket!.destroyed,
          }).toEqual({
            statusLines,
            bodyStart: statusLines.length > 0 ? "\r\n\r\n" : "",
            bodyLength: body.length,
            bodyMatches: true,
            serverSocketDestroyed: clientEndedFirst ? undefined : false,
          });

          client.end();
          await serverSocketClosed;
        } finally {
          client.destroy();
        }
      },
    );
  });
});
