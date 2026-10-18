import net from 'node:net';
import { helloFrame, HelloFlag, encodeFrame, FrameReader, type Frame, FrameType } from './protocol.js';

export interface Endpoint {
  addresses: string[];
  port: number;
  token: string;
}

const connectOnce = (host: string, port: number, timeoutMs: number): Promise<net.Socket> => {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out connecting to ' + host + ':' + port));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      // A sandbox that vanished (closed hard, ended in Task Manager) never closes the connection: keepalive notices
      // within seconds, so an attached terminal or the web's bridge ends instead of hanging on.
      socket.setKeepAlive(true, KEEPALIVE_IDLE_MS);
      resolve(socket);
    });
    socket.once('error', (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
  });
};

/** Tries every address the sandbox published and returns the first one that answers. */
/** Idle time before TCP keepalive probes start (the same as ptyhost's own side). */
const KEEPALIVE_IDLE_MS = 10_000;

export async function connect(endpoint: Endpoint, timeoutMs = 3000): Promise<net.Socket> {
  const errors: string[] = [];
  for (const address of endpoint.addresses) {
    try {
      return await connectOnce(address, endpoint.port, timeoutMs);
    } catch (e) {
      errors.push(address + ': ' + (e instanceof Error ? e.message : String(e)));
    }
  }
  throw new Error('Could not reach the sandbox session (' + errors.join('; ') + ')');
}

/** Sends one control frame (e.g. RESTART) without taking over the screen. */
export async function sendControl(endpoint: Endpoint, type: number): Promise<void> {
  const socket = await connect(endpoint);
  await new Promise<void>((resolve) =>
    socket.end(Buffer.concat([helloFrame(endpoint.token, 80, 24, HelloFlag.ControlOnly), encodeFrame(type)]), resolve),
  );
}

/** Who is watching a session right now: `remote` counts viewers on the PC (not the sandbox's own tabs). */
export interface Viewers {
  viewers: number;
  remote: number;
}

/**
 * Asks a session's ptyhost who is attached. Only viewers heard from in the last few seconds count, so a terminal that
 * was closed (or a PC that went to sleep) is not reported. null when the session does not answer: an older ptyhost
 * treats the query as a silent control connection, so the caller must not assume anything.
 */
export async function queryViewers(endpoint: Endpoint, timeoutMs = 2000): Promise<Viewers | null> {
  let socket: net.Socket;
  try {
    socket = await connect(endpoint, timeoutMs);
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const reader = new FrameReader();
    const done = (value: Viewers | null): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.on('data', (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = reader.push(chunk);
      } catch {
        done(null);
        return;
      }
      const status = frames.find((f) => f.type === FrameType.Status && f.payload.length >= 4);
      if (status) done({ viewers: status.payload.readInt16LE(0), remote: status.payload.readInt16LE(2) });
      else if (frames.some((f) => f.type === FrameType.Error)) done(null);
    });
    socket.on('error', () => done(null));
    socket.on('close', () => done(null));
    socket.write(helloFrame(endpoint.token, 80, 24, HelloFlag.Query));
  });
}
