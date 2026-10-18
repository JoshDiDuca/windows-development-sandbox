// React's way into the RPC client: the client for the page, a query's data (live queries follow their subscription,
// the rest are TanStack Query fetches), and running an action of a page with progress, questions and the result shown
// as notifications and modals.
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { operationById } from '../../../src/app/features/defs';
import { Cancelled, type OperationAction, type QueryDef } from '../../../src/app/kernel/index';
import { askInModal } from '../render/QuestionModal';
import type { RpcClient } from './client';

const RpcContext = createContext<RpcClient | null>(null);

export function RpcProvider({ client, children }: { readonly client: RpcClient; readonly children: ReactNode }) {
  return <RpcContext.Provider value={client}>{children}</RpcContext.Provider>;
}

export function useRpc(): RpcClient {
  const client = useContext(RpcContext);
  if (!client) throw new Error('useRpc needs an RpcProvider');
  return client;
}

/** A query never asks: a question from one is answered no. */
const noQuestions = { ask: () => Promise.resolve(undefined) };

export interface QueryData {
  readonly data: unknown;
  readonly error: Error | null;
  readonly pending: boolean;
}

/** A query's result: kept fresh by its subscription when it is live, fetched once (and after actions) otherwise. */
export function useQueryData(def: QueryDef, input: unknown): QueryData {
  const client = useRpc();
  const queryClient = useQueryClient();
  const live = def.live !== undefined;
  const inputKey = JSON.stringify(input ?? {});
  const [failure, setFailure] = useState<Error | null>(null);
  const query = useQuery({
    queryKey: [def.id, inputKey],
    queryFn: () => client.call(def.id, input, noQuestions),
    enabled: !live,
  });
  useEffect(() => {
    if (!live) return undefined;
    return client.subscribe(
      def.id,
      JSON.parse(inputKey) as unknown,
      (data) => {
        setFailure(null);
        queryClient.setQueryData([def.id, inputKey], data);
      },
      setFailure,
    );
  }, [client, queryClient, def.id, inputKey, live]);
  const error = failure ?? query.error;
  return { data: query.data, error, pending: query.data === undefined && !error };
}

/** How an action ended: done (with the operation's words), or failed (with what to do), or backed out of. */
export type Outcome =
  | {
      readonly ok: true;
      readonly text: string;
      /** What the operation returned (checked by its output schema). */ readonly output: unknown;
    }
  | { readonly ok: false; readonly message: string; readonly fix?: string }
  | { readonly ok: false; readonly cancelled: true; readonly message: string };

export interface RunOptions {
  /** A change made in place (a setting): a short note when it worked, the failure shown by the caller. */
  readonly inline?: boolean;
}

/** Runs a page's operation action: questions in modals, progress and the result as notifications. */
export function useRunAction(): (
  action: OperationAction,
  values?: Readonly<Record<string, unknown>>,
  options?: RunOptions,
) => Promise<Outcome> {
  const client = useRpc();
  const queryClient = useQueryClient();
  return useCallback(
    async (action, values = {}, options = {}) => {
      const def = operationById(action.op);
      const id = 'op-' + Date.now();
      const said: string[] = [];
      let shown = false;
      try {
        const output = await client.call(
          action.op,
          { ...action.input, ...values },
          {
            progress: (text) => {
              const note = { id, title: action.label, message: text, loading: true, autoClose: false } as const;
              if (shown) notifications.update(note);
              else notifications.show(note);
              shown = true;
            },
            log: (text) => said.push(text),
            ask: (question) => askInModal(question, said.splice(0)),
          },
        );
        const text = def?.text?.(output) ?? 'Done.';
        const result = {
          id,
          title: options.inline ? undefined : action.label,
          message: text,
          color: 'green',
          loading: false,
          autoClose: options.inline ? 2500 : 5000,
        };
        if (shown) notifications.update(result);
        else notifications.show(result);
        return { ok: true, text, output };
      } catch (e) {
        if (shown) notifications.hide(id);
        if (e instanceof Cancelled) return { ok: false, cancelled: true, message: 'Cancelled.' };
        const message = e instanceof Error ? e.message : 'It did not work.';
        const fix = (e as { fix?: string }).fix ?? (said.length ? said.join(' ') : undefined);
        if (!options.inline) notifications.show({ title: message, message: fix, color: 'red', autoClose: 10000 });
        return { ok: false, message, fix };
      } finally {
        await queryClient.invalidateQueries();
      }
    },
    [client, queryClient],
  );
}
