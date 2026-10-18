// An action's one field changed in place (a setting's control in its row): switches and choices save at once, text,
// numbers and paths when you press Enter or leave the box, lists when they change; secrets and shapes no control fits
// open the action's form. Checked by the Field before it is sent; the operation's own answer is shown under it.
import {
  Button,
  Group,
  Loader,
  MultiSelect,
  NumberInput,
  Select,
  Stack,
  Switch,
  TagsInput,
  Text,
  TextInput,
} from '@mantine/core';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { fieldProblem, type Field, type OperationAction } from '../../../src/app/kernel/index';
import { useRunAction } from '../rpc/hooks';
import { askFields } from './ActionForm';
import { BrowseButton } from './FieldInput';

const CUSTOM = '@custom';

interface InlineFieldProps {
  readonly action: OperationAction;
  /** Shown instead of the value for a secret or a shape ("3 entries"). */
  readonly summary?: string;
}

/** Fields that are edited in place; the rest open the form. */
export function editsInPlace(field: Field): boolean {
  if (['boolean', 'enum', 'number', 'text', 'path'].includes(field.kind)) return true;
  return field.kind === 'list' && ['enum', 'text', 'path'].includes(field.element?.kind ?? '');
}

export function InlineField({ action, summary }: InlineFieldProps) {
  const run = useRunAction();
  const field = action.fields?.[0];
  const saved = action.initial?.[field?.name ?? ''];
  const [draft, setDraft] = useState<unknown>(saved);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const savedKey = JSON.stringify(saved ?? null);
  useEffect(() => setDraft(JSON.parse(savedKey) as unknown), [savedKey]);
  if (!field) return null;

  const save = async (value: unknown): Promise<void> => {
    if (JSON.stringify(value ?? null) === savedKey) return;
    const wrong = fieldProblem(field, value);
    if (wrong) {
      setProblem(wrong);
      return;
    }
    setBusy(true);
    setProblem(null);
    const outcome = await run(action, { [field.name]: value }, { inline: true });
    setBusy(false);
    if (!outcome.ok && !('cancelled' in outcome)) {
      setProblem(outcome.message + (outcome.fix ? ' ' + outcome.fix : ''));
      setDraft(JSON.parse(savedKey) as unknown);
    }
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') void save(draft);
    if (e.key === 'Escape') setDraft(JSON.parse(savedKey) as unknown);
  };
  const spinner = busy ? <Loader size={14} /> : undefined;
  const error = problem ?? undefined;

  if (!editsInPlace(field))
    return (
      <Group justify="flex-end" gap="sm" wrap="nowrap">
        {summary && (
          <Text size="sm" c="dimmed" truncate>
            {summary}
          </Text>
        )}
        <Button
          variant="default"
          size="xs"
          onClick={() =>
            void askFields(action).then(async (values) => {
              if (values) await run(action, values, { inline: true });
            })
          }
        >
          {field.kind === 'secret' ? 'Set…' : 'Edit…'}
        </Button>
      </Group>
    );

  switch (field.kind) {
    case 'boolean':
      return (
        <Stack gap={4} align="flex-end">
          <Group gap="xs">
            {spinner}
            <Switch
              checked={draft === true}
              aria-label={field.label}
              disabled={busy}
              onChange={(e) => {
                const next = e.currentTarget.checked;
                setDraft(next);
                void save(next);
              }}
            />
          </Group>
          {error && <Problem text={error} />}
        </Stack>
      );
    case 'enum': {
      const options = (field.choices ?? []).map((c) => ({ value: String(c.value), label: c.label }));
      const known = field.choices?.some((c) => c.value === draft) ?? false;
      const custom = !known && draft !== undefined && field.open !== undefined;
      return (
        <Stack gap={6}>
          <Select
            aria-label={field.label}
            data={[...options, ...(field.open ? [{ value: CUSTOM, label: 'Custom…' }] : [])]}
            value={custom ? CUSTOM : known ? String(draft) : null}
            rightSection={spinner}
            error={custom ? undefined : error}
            disabled={busy}
            onChange={(picked) => {
              if (picked === CUSTOM) {
                setDraft(field.open?.kind === 'number' ? (field.open.min ?? 0) : '');
                return;
              }
              const value = field.choices?.find((c) => String(c.value) === picked)?.value;
              setDraft(value);
              void save(value);
            }}
          />
          {custom && field.open && (
            <OpenValue field={field.open} value={draft} error={error} onChange={setDraft} onSave={save} />
          )}
        </Stack>
      );
    }
    case 'number':
      return <OpenValue field={field} value={draft} error={error} onChange={setDraft} onSave={save} busy={busy} />;
    case 'path':
      return (
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <TextInput
            style={{ flex: 1 }}
            aria-label={field.label}
            ff="monospace"
            size="sm"
            value={typeof draft === 'string' ? draft : ''}
            placeholder={field.literals?.length ? field.literals.join(' or ') + ', or a path' : 'C:\\…'}
            rightSection={spinner}
            error={error}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onBlur={() => void save(draft)}
            onKeyDown={onEnter}
          />
          <BrowseButton
            field={field}
            value={typeof draft === 'string' ? draft : undefined}
            onPick={(picked) => {
              setDraft(picked);
              void save(picked);
            }}
          />
        </Group>
      );
    case 'list': {
      const items = Array.isArray(draft) ? draft.map((v) => String(v)) : [];
      const element = field.element;
      if (element?.kind === 'enum')
        return (
          <MultiSelect
            aria-label={field.label}
            data={(element.choices ?? []).map((c) => ({ value: String(c.value), label: c.label }))}
            value={items}
            error={error}
            rightSection={spinner}
            onChange={(picked) => {
              const value = picked.map((p) => element.choices?.find((c) => String(c.value) === p)?.value ?? p);
              setDraft(value);
              void save(value);
            }}
          />
        );
      const change = (value: string[]): void => {
        setDraft(value);
        void save(value);
      };
      return (
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <TagsInput
            style={{ flex: 1 }}
            aria-label={field.label}
            value={items}
            placeholder={items.length ? undefined : 'Type and press Enter'}
            error={error}
            rightSection={spinner}
            onChange={change}
            clearable
          />
          {element?.kind === 'path' && (
            <BrowseButton
              field={field}
              value={undefined}
              onPick={(picked) => change(items.includes(picked) ? items : [...items, picked])}
            />
          )}
        </Group>
      );
    }
    default:
      return (
        <TextInput
          aria-label={field.label}
          value={typeof draft === 'string' ? draft : ''}
          rightSection={spinner}
          error={error}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={() => void save(draft)}
          onKeyDown={onEnter}
        />
      );
  }
}

interface OpenValueProps {
  readonly field: Field;
  readonly value: unknown;
  readonly error?: string;
  readonly busy?: boolean;
  readonly onChange: (value: unknown) => void;
  readonly onSave: (value: unknown) => Promise<void>;
}

/** A number or a text of your own (a "Custom…" choice, or a plain number setting). */
function OpenValue({ field, value, error, busy, onChange, onSave }: OpenValueProps) {
  const keys = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') void onSave(value);
  };
  if (field.kind === 'number')
    return (
      <NumberInput
        aria-label={field.label}
        value={typeof value === 'number' ? value : ''}
        min={field.min}
        max={field.max}
        allowDecimal={!field.integer}
        thousandSeparator=","
        placeholder={field.range}
        rightSection={busy ? <Loader size={14} /> : undefined}
        error={error}
        onChange={(n) => onChange(typeof n === 'number' ? n : undefined)}
        onBlur={() => void onSave(value)}
        onKeyDown={keys}
      />
    );
  return (
    <TextInput
      aria-label={field.label}
      value={typeof value === 'string' ? value : ''}
      error={error}
      onChange={(e) => onChange(e.currentTarget.value)}
      onBlur={() => void onSave(value)}
      onKeyDown={keys}
    />
  );
}

function Problem({ text }: { readonly text: string }) {
  return (
    <Text size="xs" c="red" ta="right">
      {text}
    </Text>
  );
}
