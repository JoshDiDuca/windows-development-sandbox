// The only way an operation talks to the person using it: progress and log lines, and questions (confirm, choose,
// text, secret, path, checklist). Each surface answers them its own way (the CLI with prompts, the menu with dialogs,
// the web with modals over RPC); a feature never knows which. Questions are plain data (QuestionSchema), so the web can
// receive them; every surface builds its OperationIO from one `Asker` with ioFromAsker().
import { z } from 'zod';
import type { Tone } from './view.js';

const Lines = z.array(z.string()).optional();
const ChoiceSchema = z.strictObject({ value: z.string(), label: z.string(), description: z.string().optional() });
export type QuestionChoice = z.output<typeof ChoiceSchema>;
/** What the CLI says and fixes when a question needs a terminal and there is none. */
const NoTerminalSchema = z.strictObject({ message: z.string(), fix: z.string() });

export const ConfirmQuestionSchema = z.strictObject({
  kind: z.literal('confirm'),
  title: z.string(),
  lines: Lines,
  /** The word on the yes button ("Stop"). */
  yes: z.string().optional(),
  danger: z.boolean().optional(),
  /** A stronger confirmation: yes means typing this word (another user's name). */
  typed: z.string().optional(),
  /**
   * A command typed on purpose is answer enough: the CLI does not ask (the menu and web still do). Without it the CLI
   * asks on a terminal, takes --yes, and fails without a terminal (with `noTerminal`, or "Add --yes").
   */
  implied: z.boolean().optional(),
  /** On the command line --yes answers no without asking: an extra step a script did not ask for (delete the image). */
  skipWithYes: z.boolean().optional(),
  noTerminal: z.strictObject({ message: z.string(), fix: z.string() }).optional(),
});

export const ChooseQuestionSchema = z.strictObject({
  kind: z.literal('choose'),
  title: z.string(),
  lines: Lines,
  choices: z.array(ChoiceSchema).min(1),
  initial: z.string().optional(),
  /** Without a terminal the CLI fails with this message and fix instead of its own (see confirm). */
  noTerminal: NoTerminalSchema.optional(),
});

export const TextQuestionSchema = z.strictObject({
  kind: z.literal('text'),
  title: z.string(),
  lines: Lines,
  initial: z.string().optional(),
  allowEmpty: z.boolean().optional(),
  /** What was wrong with the last answer (asked again). */
  problem: z.string().optional(),
  noTerminal: NoTerminalSchema.optional(),
});

export const SecretQuestionSchema = z.strictObject({
  kind: z.literal('secret'),
  title: z.string(),
  lines: Lines,
  problem: z.string().optional(),
});

export const PathQuestionSchema = z.strictObject({
  kind: z.literal('path'),
  title: z.string(),
  lines: Lines,
  pathKind: z.enum(['dir', 'file']),
  initial: z.string().optional(),
  /** Words allowed instead of a path ("auto"). */
  literals: z.array(z.string()).optional(),
  problem: z.string().optional(),
  noTerminal: NoTerminalSchema.optional(),
});

export const ChecklistQuestionSchema = z.strictObject({
  kind: z.literal('checklist'),
  title: z.string(),
  lines: Lines,
  choices: z.array(ChoiceSchema),
  checked: z.array(z.string()).optional(),
  noTerminal: NoTerminalSchema.optional(),
});

export const QuestionSchema = z.discriminatedUnion('kind', [
  ConfirmQuestionSchema,
  ChooseQuestionSchema,
  TextQuestionSchema,
  SecretQuestionSchema,
  PathQuestionSchema,
  ChecklistQuestionSchema,
]);
export type Question = z.output<typeof QuestionSchema>;
export type ConfirmQuestion = z.output<typeof ConfirmQuestionSchema>;
export type ChooseQuestion = z.output<typeof ChooseQuestionSchema>;
export type TextQuestion = z.output<typeof TextQuestionSchema>;
export type SecretQuestion = z.output<typeof SecretQuestionSchema>;
export type PathQuestion = z.output<typeof PathQuestionSchema>;
export type ChecklistQuestion = z.output<typeof ChecklistQuestionSchema>;

/** The answer each kind of question gets (undefined = backed out). */
export interface AnswerOf {
  confirm: boolean;
  choose: string | undefined;
  text: string | undefined;
  secret: string | undefined;
  path: string | undefined;
  checklist: string[] | undefined;
}
export type Answer = AnswerOf[keyof AnswerOf];

/** The wire shape of an answer for each kind (the server checks what the browser sends). */
export const ANSWER_SCHEMAS: { readonly [K in keyof AnswerOf]: z.ZodType<AnswerOf[K]> } = {
  confirm: z.boolean(),
  choose: z.string().max(1000).optional(),
  text: z.string().max(10000).optional(),
  secret: z.string().max(10000).optional(),
  path: z.string().max(2000).optional(),
  checklist: z.array(z.string().max(1000)).max(1000).optional(),
};

/** A check of a typed answer: true, or what is wrong (the question is asked again with it). */
export type Validate = (value: string) => true | string;

type Ask<K extends keyof AnswerOf, Q> = (question: Omit<Q, 'kind'>) => Promise<AnswerOf[K]>;
type AskTyped<K extends keyof AnswerOf, Q> = (
  question: Omit<Q, 'kind'> & { validate?: Validate },
) => Promise<AnswerOf[K]>;

export interface OperationIO {
  /** What is happening now (a spinner in the CLI, a notice in the menu, a progress line in the web). */
  progress(text: string): void;
  /** A line of output worth keeping. */
  log(text: string, tone?: Tone): void;
  confirm: Ask<'confirm', ConfirmQuestion>;
  choose: Ask<'choose', ChooseQuestion>;
  text: AskTyped<'text', TextQuestion>;
  secret: AskTyped<'secret', SecretQuestion>;
  path: AskTyped<'path', PathQuestion>;
  checklist: Ask<'checklist', ChecklistQuestion>;
}

/** Asks one question the way a surface can. */
export type Asker = <Q extends Question>(question: Q) => Promise<AnswerOf[Q['kind']]>;

/** Where progress and log lines go. */
export interface OutputSink {
  progress(text: string): void;
  log(text: string, tone?: Tone): void;
}

/** Asks a typed question until `validate` accepts the answer (each new try names the problem). */
async function untilValid(
  asker: Asker,
  question: TextQuestion | SecretQuestion | PathQuestion,
  validate: Validate | undefined,
): Promise<string | undefined> {
  for (let q = question; ;) {
    const answer = (await asker(q)) as string | undefined;
    if (answer === undefined || !validate) return answer;
    const verdict = validate(answer);
    if (verdict === true) return answer;
    q = { ...q, problem: verdict };
  }
}

/** An OperationIO from one way of asking and one place for output lines. */
export function ioFromAsker(asker: Asker, sink: OutputSink): OperationIO {
  return {
    progress: (text) => sink.progress(text),
    log: (text, tone) => sink.log(text, tone),
    confirm: (q) => asker({ ...q, kind: 'confirm' }),
    choose: (q) => asker({ ...q, kind: 'choose' }),
    text: ({ validate, ...q }) => untilValid(asker, { ...q, kind: 'text' }, validate),
    secret: ({ validate, ...q }) => untilValid(asker, { ...q, kind: 'secret' }, validate),
    path: ({ validate, ...q }) => untilValid(asker, { ...q, kind: 'path' }, validate),
    checklist: (q) => asker({ ...q, kind: 'checklist' }),
  };
}

/** What a FakeIO saw: every question asked and every line written. */
export interface FakeIORecord {
  readonly questions: Question[];
  readonly progress: string[];
  readonly logs: { text: string; tone?: Tone }[];
}

/**
 * An OperationIO for tests: answers come from a list in order (a function gets the question). Running out of answers
 * fails the test with the question that had none.
 */
export function fakeIO(answers: readonly (Answer | ((q: Question) => Answer))[] = []): {
  io: OperationIO;
  seen: FakeIORecord;
} {
  const queue = [...answers];
  const seen: FakeIORecord = { questions: [], progress: [], logs: [] };
  const asker: Asker = (question) => {
    seen.questions.push(question);
    if (!queue.length) return Promise.reject(new Error('No answer for: ' + question.title));
    const next = queue.shift();
    return Promise.resolve((typeof next === 'function' ? next(question) : next) as never);
  };
  const io = ioFromAsker(asker, {
    progress: (text) => seen.progress.push(text),
    log: (text, tone) => seen.logs.push({ text, ...(tone ? { tone } : {}) }),
  });
  return { io, seen };
}

/** For reads that never ask (queries): output is dropped, and a question is a bug. */
export const NO_QUESTIONS: OperationIO = ioFromAsker(
  (question) => Promise.reject(new Error('A query asked a question: ' + question.title)),
  { progress: () => undefined, log: () => undefined },
);
