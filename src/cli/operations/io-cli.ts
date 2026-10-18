// OperationIO on the command line: progress as a spinner line on stderr, log lines on stdout, questions through
// @inquirer/prompts (core/prompt.ts). --yes answers confirmations; without a terminal a question the operation needs
// fails and says what to type instead (the askRequired rule).
import type { Answer, Asker, OperationIO, Question, Tone } from '../../app/kernel/index.js';
import { ioFromAsker } from '../../app/kernel/index.js';
import { askChoice, askChoices, askName, askRequired, askSecret, askTyped } from '../../core/prompt.js';
import { fail } from '../../core/util/index.js';
import type { CliOptions } from '../args.js';
import { c, ProgressLine } from '../output/index.js';

/** What to do instead when there is no terminal to ask in. */
const NO_TERMINAL_FIX = 'Run it in a terminal, or give the value on the command line.';

const PAINT: Readonly<Record<Tone, (text: string) => string>> = {
  ok: c.green,
  warn: c.yellow,
  danger: c.red,
  muted: c.dim,
  accent: c.bold,
};

/** The question in one line, as a prompt says it: its lines, then the question itself. */
function promptText(q: Question): string {
  return [...(q.lines ?? []), q.title].join(' ');
}

function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function ask(q: Question, options: CliOptions): Promise<Answer> {
  if ('problem' in q && q.problem) console.log(c.yellow(q.problem));
  // A question with its own words for "no terminal" fails with them, before any other way of asking (confirm has its
  // own rule: --yes and implied answer it).
  if (q.kind !== 'confirm' && !interactive() && 'noTerminal' in q && q.noTerminal)
    fail(q.noTerminal.message, q.noTerminal.fix);
  switch (q.kind) {
    case 'confirm': {
      if (q.skipWithYes && options.yes) return false;
      if (q.implied || options.yes) return true;
      if (!interactive())
        fail(
          q.noTerminal?.message ?? 'Cannot ask here (no terminal).',
          q.noTerminal?.fix ?? 'Add --yes to answer yes.',
        );
      if (q.typed) return askTyped(promptText(q), q.typed);
      return askRequired(promptText(q), q.noTerminal?.fix);
    }
    case 'choose':
      return askChoice(
        promptText(q),
        q.choices.map((ch) => ({ name: ch.label, value: ch.value, description: ch.description })),
        NO_TERMINAL_FIX,
      );
    case 'checklist':
      return askChoices(
        promptText(q),
        q.choices.map((ch) => ({ name: ch.label, value: ch.value, description: ch.description })),
        NO_TERMINAL_FIX,
      );
    case 'secret':
      return askSecret(promptText(q), NO_TERMINAL_FIX);
    case 'text':
    case 'path': {
      const answer = await askName(promptText(q), NO_TERMINAL_FIX);
      return answer === '' && q.kind === 'text' && !q.allowEmpty ? undefined : answer;
    }
  }
}

/** An OperationIO for one command; close() removes a progress line still shown. */
export function cliIO(options: CliOptions): { io: OperationIO; close: () => void } {
  const progress = new ProgressLine();
  const asker: Asker = async (q) => {
    progress.stop();
    return (await ask(q, options)) as never;
  };
  // With --json the lines go to stderr, so stdout is the JSON alone.
  const write = options.json ? console.error : console.log;
  const io = ioFromAsker(asker, {
    progress: (text) => progress.show(text),
    log: (text, tone) => {
      progress.stop();
      write(tone ? PAINT[tone](text) : text);
    },
  });
  return { io, close: () => progress.stop() };
}
