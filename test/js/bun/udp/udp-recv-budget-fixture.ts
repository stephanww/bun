// One readable event of a UDP socket hands over at most 32 datagrams and, on
// Linux, 32 error-queue reports. What is left arrives with the next turn of the
// loop. Each scenario queues a backlog in the kernel, counts what every loop
// turn delivers, and prints one line of JSON.
//
// Spawned by udp_socket.test.ts and dgram.test.ts with the scenario name.
import { createSocket, type Socket } from "node:dgram";

const HOST = "127.0.0.1";
const quiet = { data() {}, error() {} };

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

// What each loop turn added to `read()`, one entry per turn that added
// something. A turn is one poll of the loop and the immediate after it.
async function countPerTurn(read: () => number, done: (idleTurns: number) => boolean) {
  const perTurn: number[] = [];
  let seen = read();
  let idleTurns = 0;
  for (let i = 0; i < 2000 && !done(idleTurns); i++) {
    await turn();
    const now = read();
    if (now === seen) {
      idleTurns++;
    } else {
      idleTurns = 0;
      perTurn.push(now - seen);
    }
    seen = now;
  }
  return perTurn;
}

function summary(perTurn: number[]) {
  return { total: perTurn.reduce((a, b) => a + b, 0), max: Math.max(0, ...perTurn), perTurn };
}

// One sendmmsg. Over loopback on Linux the burst is in the receive queue when
// the call returns.
function queue(sender: Bun.udp.Socket<"buffer">, port: number, count: number) {
  const packets: (string | number)[] = [];
  for (let i = 0; i < count; i++) packets.push("x", port, HOST);
  const sent = sender.sendMany(packets);
  if (sent !== count) throw new Error(`sendMany accepted ${sent} of ${count}`);
}

function bound(socket: Socket) {
  return new Promise<number>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, HOST, () => {
      socket.off("error", reject);
      resolve(socket.address().port);
    });
  });
}

// Reserves a port and frees it: a datagram sent there comes back as an ICMP
// port-unreachable.
async function deadPort() {
  const socket = await Bun.udpSocket({ hostname: HOST, port: 0, socket: quiet });
  const port = socket.port;
  socket.close();
  return port;
}

// Linux. The poll reports EPOLLERR for a pending ICMP error, and a send from an
// earlier callback of the same turn takes that error before the socket's own
// event runs. The error queue is empty and recvmmsg returns only data, so the
// event ends on its bound with no answer about the error. The socket has to
// stay open and deliver the rest.
//
// "adopted": a descriptor bun did not create has no IP_RECVERR, so the kernel
// never queues a report. "full-buffer": a socket bun created, whose receive
// buffer has no room left for the report.
async function residual(kind: "adopted" | "full-buffer") {
  const { _createSocketHandle, kStateSymbol } = require("bun:internal-for-testing").exposedInternals["internal/dgram"];
  let received = 0;
  let tookTheError = false;

  const peer = await Bun.udpSocket({ hostname: HOST, port: 0, socket: quiet });
  const nudge = await Bun.udpSocket({ hostname: HOST, port: 0, socket: quiet });

  // Created first and made readable first, so the loop runs this callback
  // before the event of `socket`.
  const first = await Bun.udpSocket({
    hostname: HOST,
    port: 0,
    socket: {
      data() {
        socket.send("y", error => {
          tookTheError = (error as NodeJS.ErrnoException | null)?.code === "ECONNREFUSED";
        });
      },
      error() {},
    },
  });

  const socket = kind === "adopted" ? createSocket("udp4") : createSocket({ type: "udp4", recvBufferSize: 64 * 1024 });
  socket.on("error", () => {});
  socket.on("message", () => {
    received++;
  });
  if (kind === "adopted") {
    const wrap = _createSocketHandle(HOST, 0, "udp4");
    if (typeof wrap === "number") throw new Error(`_createSocketHandle failed: ${wrap}`);
    const { promise, resolve } = Promise.withResolvers<void>();
    socket.once("listening", resolve);
    socket.bind({ fd: wrap.fd });
    await promise;
  } else {
    await bound(socket);
  }
  await new Promise<void>(resolve => socket.connect(peer.port, HOST, () => resolve()));
  const native = socket[kStateSymbol].handle.socket;
  const port = socket.address().port;

  // Every socket starts writable. Let those events pass, so that the order of
  // the two events below is the order they are raised in.
  for (let i = 0; i < 4; i++) await turn();

  // All of this before the loop polls again. 400 is more than the 64 KiB
  // receive buffer holds.
  const sent = kind === "adopted" ? 40 : 400;
  nudge.send("go", first.port, HOST);
  queue(peer, port, sent);
  peer.close();
  socket.send("x");

  const perTurn = await countPerTurn(
    () => received,
    idleTurns => native.closed || received === sent || idleTurns === 50,
  );
  const closed = native.closed;
  socket.close();
  first.close();
  nudge.close();
  return { residual: tookTheError, closed, sent, ...summary(perTurn) };
}

const scenarios: Record<string, () => Promise<{ max: number; residual?: boolean }>> = {
  // 100 datagrams queued on a Bun.udpSocket.
  async backlog() {
    let received = 0;
    const receiver = await Bun.udpSocket({
      hostname: HOST,
      port: 0,
      socket: {
        data() {
          received++;
        },
      },
    });
    const sender = await Bun.udpSocket({ hostname: HOST, port: 0, socket: quiet });
    queue(sender, receiver.port, 100);
    const perTurn = await countPerTurn(
      () => received,
      () => received === 100,
    );
    receiver.close();
    sender.close();
    return summary(perTurn);
  },

  // The handler of the first datagram queues 100 more on its own socket. The
  // event that has read 7 by then has 25 left: not 32, and not 4 more batches.
  async refill() {
    let received = 0;
    const sender = await Bun.udpSocket({ hostname: HOST, port: 0, socket: quiet });
    const receiver = await Bun.udpSocket({
      hostname: HOST,
      port: 0,
      socket: {
        data(socket) {
          if (++received === 1) queue(sender, socket.port, 100);
        },
      },
    });
    queue(sender, receiver.port, 7);
    const perTurn = await countPerTurn(
      () => received,
      () => received === 107,
    );
    receiver.close();
    sender.close();
    return summary(perTurn);
  },

  // Linux. The error handler sends again to the dead port, so the next report
  // is queued before the drain asks for it. 100 sends in all.
  async "error-storm"() {
    const port = await deadPort();
    let errors = 0;
    let untagged = 0;
    let sends = 0;
    const socket = await Bun.udpSocket({
      hostname: HOST,
      port: 0,
      socket: {
        data() {},
        error(...args: unknown[]) {
          errors++;
          if ((args.at(-1) as { errqueue?: boolean }).errqueue !== true) untagged++;
          if (sends < 100) {
            sends++;
            socket.send("x", port, HOST);
          }
        },
      },
    });
    sends++;
    socket.send("x", port, HOST);
    const perTurn = await countPerTurn(
      () => errors,
      idleTurns => errors === 100 || idleTurns === 50,
    );
    socket.close();
    return { untagged, ...summary(perTurn) };
  },

  // Linux. 40 reports on the error queue and 10 datagrams behind them. An
  // error without `errqueue` is a failed recvmmsg: stopping the drain early
  // must not cause one.
  async "error-backlog"() {
    const port = await deadPort();
    let tagged = 0;
    let untagged = 0;
    let received = 0;
    const socket = await Bun.udpSocket({
      hostname: HOST,
      port: 0,
      socket: {
        data() {
          received++;
        },
        error(...args: unknown[]) {
          if ((args.at(-1) as { errqueue?: boolean }).errqueue === true) tagged++;
          else untagged++;
        },
      },
    });
    const sender = await Bun.udpSocket({ hostname: HOST, port: 0, socket: quiet });
    // A report that has arrived fails the next send once, so this takes about
    // two sends for each report.
    let reports = 0;
    for (let i = 0; i < 400 && reports < 40; i++) {
      try {
        if (socket.send("x", port, HOST)) reports++;
      } catch {}
    }
    queue(sender, socket.port, 10);
    const perTurn = await countPerTurn(
      () => tagged,
      idleTurns => (tagged === reports && received === 10) || idleTurns === 50,
    );
    socket.close();
    sender.close();
    return { reports, untagged, received, ...summary(perTurn) };
  },

  // 100 datagrams queued on a node:dgram socket.
  async "dgram-backlog"() {
    let received = 0;
    const receiver = createSocket("udp4");
    receiver.on("message", () => {
      received++;
    });
    const port = await bound(receiver);
    const sender = await Bun.udpSocket({ hostname: HOST, port: 0, socket: quiet });
    queue(sender, port, 100);
    const perTurn = await countPerTurn(
      () => received,
      () => received === 100,
    );
    receiver.close();
    sender.close();
    return summary(perTurn);
  },

  // The bound belongs to one socket and one event: two sockets with 100 each
  // deliver 64 in a turn.
  async "dgram-two-sockets"() {
    let received = 0;
    const receivers = [createSocket("udp4"), createSocket("udp4")];
    const sender = await Bun.udpSocket({ hostname: HOST, port: 0, socket: quiet });
    const ports: number[] = [];
    for (const receiver of receivers) {
      receiver.on("message", () => {
        received++;
      });
      ports.push(await bound(receiver));
    }
    for (const port of ports) queue(sender, port, 100);
    const perTurn = await countPerTurn(
      () => received,
      () => received === 200,
    );
    for (const receiver of receivers) receiver.close();
    sender.close();
    return summary(perTurn);
  },

  "residual-adopted": () => residual("adopted"),
  "residual-full-buffer": () => residual("full-buffer"),
};

const name = process.argv[2];
const scenario = scenarios[name];
if (!scenario) throw new Error(`unknown scenario: ${name}`);

// A scenario shows the bound only when its backlog was in the kernel before the
// loop polled the socket, and the residual ones only when the send took the
// error. Nothing promises either on every platform and under every load, so a
// run that did not get there is set up again. The first run that did is the
// result. After 20 the last one is, and the test fails on it.
const reached = name.startsWith("residual-")
  ? (result: { residual?: boolean }) => result.residual === true
  : (result: { max: number }) => result.max >= 32;
for (let attempt = 1; ; attempt++) {
  const result = await scenario();
  if (reached(result) || attempt === 20) {
    console.log(JSON.stringify({ ...result, attempt }));
    break;
  }
}
