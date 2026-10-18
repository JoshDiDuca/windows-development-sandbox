// The web's answer to an operation's questions (io.confirm, choose, text, secret, path, checklist): one modal per
// question. Closing it is "no" (or "backed out"), as Esc is in the menu.
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Group,
  PasswordInput,
  Radio,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { useState, type FormEvent } from 'react';
import { IconFolderOpen } from '@tabler/icons-react';
import type { Answer, Question } from '../../../src/app/kernel/index';
import { pickPath } from './FolderPicker';

interface QuestionFormProps {
  readonly question: Question;
  /** What the operation said before asking (shown above the question). */
  readonly said: readonly string[];
  readonly done: (answer: Answer) => void;
}

/** "no" for each kind of question: what closing the modal answers. */
export function declined(q: Question): Answer {
  return q.kind === 'confirm' ? false : undefined;
}

function QuestionForm({ question: q, said, done }: QuestionFormProps) {
  const [text, setText] = useState(q.kind === 'text' || q.kind === 'path' ? (q.initial ?? '') : '');
  const [choice, setChoice] = useState(q.kind === 'choose' ? (q.initial ?? q.choices[0]?.value ?? '') : '');
  const [ticked, setTicked] = useState<string[]>(q.kind === 'checklist' ? [...(q.checked ?? [])] : []);
  const lines = [...said, ...(q.lines ?? [])];
  const problem = 'problem' in q ? q.problem : undefined;
  const typedOk = q.kind !== 'confirm' || !q.typed || text.trim().toLowerCase() === q.typed;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (q.kind === 'confirm') done(typedOk);
    else if (q.kind === 'choose') done(choice);
    else if (q.kind === 'checklist') done(ticked);
    else done(text === '' && q.kind === 'text' && !q.allowEmpty ? undefined : text);
  };

  return (
    <form onSubmit={submit}>
      <Stack gap="sm">
        {lines.map((line, i) => (
          <Text key={i} size="sm">
            {line}
          </Text>
        ))}
        {problem && (
          <Alert color="orange" variant="light" p="xs">
            {problem}
          </Alert>
        )}
        {q.kind === 'confirm' && q.typed && (
          <TextInput
            label={'Type "' + q.typed + '" to confirm'}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            data-autofocus
          />
        )}
        {q.kind === 'choose' && (
          <Radio.Group value={choice} onChange={setChoice}>
            <Stack gap="xs">
              {q.choices.map((c) => (
                <Radio key={c.value} value={c.value} label={c.label} description={c.description} />
              ))}
            </Stack>
          </Radio.Group>
        )}
        {q.kind === 'checklist' && (
          <Checkbox.Group value={ticked} onChange={setTicked}>
            <Stack gap="xs">
              {q.choices.map((c) => (
                <Checkbox key={c.value} value={c.value} label={c.label} description={c.description} />
              ))}
            </Stack>
          </Checkbox.Group>
        )}
        {q.kind === 'text' && (
          <TextInput value={text} onChange={(e) => setText(e.currentTarget.value)} data-autofocus />
        )}
        {q.kind === 'path' && (
          <Group gap="xs" wrap="nowrap" align="flex-end">
            <TextInput
              style={{ flex: 1 }}
              ff="monospace"
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              description={'The full path of a ' + (q.pathKind === 'file' ? 'file' : 'folder') + ' on this PC'}
              data-autofocus
            />
            <Tooltip label={q.pathKind === 'file' ? 'Choose a file' : 'Choose a folder'}>
              <ActionIcon
                variant="default"
                size={36}
                aria-label="Browse"
                onClick={() => void pickPath(q.pathKind, text || undefined).then((picked) => picked && setText(picked))}
              >
                <IconFolderOpen size={18} stroke={1.6} />
              </ActionIcon>
            </Tooltip>
          </Group>
        )}
        {q.kind === 'secret' && (
          <PasswordInput value={text} onChange={(e) => setText(e.currentTarget.value)} data-autofocus />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={() => done(declined(q))}>
            Cancel
          </Button>
          <Button type="submit" color={q.kind === 'confirm' && q.danger ? 'red' : undefined} disabled={!typedOk}>
            {q.kind === 'confirm' ? (q.yes ?? 'Yes') : 'OK'}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

/** Asks one question in a modal; resolves with the answer (closing the modal declines). */
export function askInModal(question: Question, said: readonly string[] = []): Promise<Answer> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer: Answer): void => {
      if (settled) return;
      settled = true;
      modals.close(id);
      resolve(answer);
    };
    const id = modals.open({
      title: question.title,
      centered: true,
      onClose: () => finish(declined(question)),
      children: <QuestionForm question={question} said={said} done={finish} />,
    });
  });
}
