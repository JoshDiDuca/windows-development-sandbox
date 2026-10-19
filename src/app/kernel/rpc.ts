// The messages of the web UI's RPC socket (/api/rpc), shared by the server and the browser. The browser calls
// operations and queries by id, answers questions, and subscribes to live queries; the server streams progress, log
// lines and questions, then a result or an error. A subscription gets `data` whenever the result changes (an `error`
// does not end it; `unsubscribe` does). The server checks every message against these schemas.
import { z } from 'zod';
import { WireErrorSchema } from './errors.js';
import type { Access, Caller } from './access.js';
import { QuestionSchema, type OperationIO } from './io.js';

/** One call or subscription on the socket (chosen by the browser, unique while it runs). */
export const RpcIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** A definition's id (sessions.restart). */
export const DefinitionIdSchema = z
  .string()
  .regex(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/)
  .max(80);
const ToneSchema = z.enum(['ok', 'warn', 'danger', 'muted', 'accent']);

export const CallMessageSchema = z.strictObject({
  t: z.literal('call'),
  id: RpcIdSchema,
  op: DefinitionIdSchema,
  input: z.unknown(),
});
export const AnswerMessageSchema = z.strictObject({ t: z.literal('answer'), id: RpcIdSchema, value: z.unknown() });
export const SubscribeMessageSchema = z.strictObject({
  t: z.literal('subscribe'),
  id: RpcIdSchema,
  query: DefinitionIdSchema,
  input: z.unknown(),
});
export const UnsubscribeMessageSchema = z.strictObject({ t: z.literal('unsubscribe'), id: RpcIdSchema });

/** Browser -> server. */
export const ClientMessageSchema = z.discriminatedUnion('t', [
  CallMessageSchema,
  AnswerMessageSchema,
  SubscribeMessageSchema,
  UnsubscribeMessageSchema,
]);
export type ClientMessage = z.output<typeof ClientMessageSchema>;

/** Server -> browser. */
export const ServerMessageSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('progress'), id: RpcIdSchema, text: z.string() }),
  z.strictObject({ t: z.literal('log'), id: RpcIdSchema, text: z.string(), tone: ToneSchema.optional() }),
  z.strictObject({ t: z.literal('ask'), id: RpcIdSchema, question: QuestionSchema }),
  z.strictObject({ t: z.literal('result'), id: RpcIdSchema, output: z.unknown() }),
  z.strictObject({ t: z.literal('error'), id: RpcIdSchema, error: WireErrorSchema }),
  z.strictObject({ t: z.literal('data'), id: RpcIdSchema, output: z.unknown() }),
]);
export type ServerMessage = z.output<typeof ServerMessageSchema>;

/** Most calls and subscriptions one socket may have open at once. */
export const MAX_OPEN_PER_SOCKET = 32;

/** What the RPC endpoint needs from the program: the definitions allowed on the web, and a way to run them. */
export interface RpcHost {
  /** 'operation' or 'query' when the id is registered and allowed on the web, else undefined. */
  kind(id: string): 'operation' | 'query' | undefined;
  /** How often a query is read again while subscribed (undefined: once). */
  liveMs(id: string): number | undefined;
  /** What a caller other than the owner needs to run it with this input (undefined: not here). */
  need(id: string, input: unknown): Access | undefined;
  /** Runs an allowed definition (input and output checked); refused when `caller` (default: the owner) may not. */
  run(id: string, input: unknown, io: OperationIO, caller?: Caller): Promise<unknown>;
}
