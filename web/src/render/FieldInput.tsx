// One Field as a Mantine input: a switch, a choice (with "Custom…" when a value of your own is allowed), a number with
// its range, text, a hidden secret, a path, tags for lists, and JSON for shapes no input fits. The same Fields the
// menu's editors read (app/kernel/fields.ts).
import {
  ActionIcon,
  Group,
  JsonInput,
  MultiSelect,
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  Switch,
  TagsInput,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconFolderOpen } from '@tabler/icons-react';
import { useState } from 'react';
import type { ChoiceValue, Field } from '../../../src/app/kernel/index';
import { pickPath } from './FolderPicker';

interface FieldInputProps {
  readonly field: Field;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly error?: string;
}

const CUSTOM = '@custom';

/** The choice values as Select options (strings), and back. */
function options(field: Field): { value: string; label: string }[] {
  return (field.choices ?? []).map((c) => ({ value: String(c.value), label: c.label }));
}
function choiceOf(field: Field, text: string | null): ChoiceValue | undefined {
  return field.choices?.find((c) => String(c.value) === text)?.value;
}

function EnumInput({ field, value, onChange, error }: FieldInputProps) {
  const known = field.choices?.some((c) => c.value === value) ?? false;
  const [custom, setCustom] = useState(!known && value !== undefined && field.open !== undefined);
  const data = [...options(field), ...(field.open ? [{ value: CUSTOM, label: 'Custom…' }] : [])];
  return (
    <Stack gap="xs">
      <Select
        label={field.label}
        description={field.help}
        data={data}
        value={custom ? CUSTOM : known ? String(value) : null}
        error={custom ? undefined : error}
        allowDeselect={false}
        onChange={(picked) => {
          setCustom(picked === CUSTOM);
          if (picked !== CUSTOM) onChange(choiceOf(field, picked));
        }}
      />
      {custom && field.open && (
        <FieldInput
          field={{ ...field.open, label: 'Your own value', help: undefined }}
          value={value}
          onChange={onChange}
          error={error}
        />
      )}
    </Stack>
  );
}

/** The button beside a path that opens the folder picker. */
export function BrowseButton({
  field,
  value,
  onPick,
}: {
  readonly field: Field;
  readonly value: string | undefined;
  readonly onPick: (path: string) => void;
}) {
  const kind = field.pathKind ?? field.element?.pathKind ?? 'dir';
  return (
    <Tooltip label={kind === 'file' ? 'Choose a file' : 'Choose a folder'}>
      <ActionIcon
        variant="default"
        size={36}
        aria-label="Browse"
        onClick={() => void pickPath(kind, value, field.label).then((picked) => picked && onPick(picked))}
      >
        <IconFolderOpen size={18} stroke={1.6} />
      </ActionIcon>
    </Tooltip>
  );
}

/** A value with no input of its own, typed as JSON. */
function JsonFieldInput({ field, value, onChange, error }: FieldInputProps) {
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value, null, 2));
  const [problem, setProblem] = useState<string | undefined>();
  return (
    <JsonInput
      label={field.label}
      description={field.help}
      value={text}
      error={problem ?? error}
      formatOnBlur
      autosize
      minRows={3}
      onChange={(next) => {
        setText(next);
        try {
          onChange(next.trim() === '' ? undefined : (JSON.parse(next) as unknown));
          setProblem(undefined);
        } catch {
          setProblem('This is not valid JSON yet.');
        }
      }}
    />
  );
}

export function FieldInput(props: FieldInputProps) {
  const { field, value, onChange, error } = props;
  const common = { label: field.label, description: field.help, error };
  switch (field.kind) {
    case 'boolean':
      return (
        <Switch
          label={field.label}
          description={field.help}
          checked={value === true}
          error={error}
          onChange={(e) => onChange(e.currentTarget.checked)}
        />
      );
    case 'enum':
      return <EnumInput {...props} />;
    case 'number':
      return (
        <NumberInput
          {...common}
          value={typeof value === 'number' ? value : ''}
          min={field.min}
          max={field.max}
          allowDecimal={!field.integer}
          placeholder={field.range}
          onChange={(n) => onChange(typeof n === 'number' ? n : undefined)}
        />
      );
    case 'secret':
      return (
        <PasswordInput
          {...common}
          value={typeof value === 'string' ? value : ''}
          placeholder="Type a new value"
          autoComplete="off"
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      );
    case 'path':
      return (
        <Group gap="xs" align="flex-end" wrap="nowrap">
          <TextInput
            {...common}
            style={{ flex: 1 }}
            ff="monospace"
            placeholder={field.literals?.length ? field.literals.join(' or ') + ', or a path' : 'C:\\…'}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.currentTarget.value)}
          />
          <BrowseButton field={field} value={typeof value === 'string' ? value : undefined} onPick={onChange} />
        </Group>
      );
    case 'text':
      return (
        <TextInput
          {...common}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      );
    case 'list': {
      const items = Array.isArray(value) ? value.map((v) => String(v)) : [];
      if (field.element?.kind === 'enum')
        return (
          <MultiSelect
            {...common}
            data={options(field.element)}
            value={items}
            onChange={(picked) => onChange(picked.map((p) => choiceOf(field.element!, p) ?? p))}
          />
        );
      if (field.element?.kind === 'path')
        return (
          <Group gap="xs" align="flex-end" wrap="nowrap">
            <TagsInput {...common} style={{ flex: 1 }} value={items} onChange={onChange} clearable />
            <BrowseButton
              field={field}
              value={undefined}
              onPick={(picked) => onChange(items.includes(picked) ? items : [...items, picked])}
            />
          </Group>
        );
      if (field.element?.kind === 'text') return <TagsInput {...common} value={items} onChange={onChange} clearable />;
      return <JsonFieldInput {...props} />;
    }
    default:
      return <JsonFieldInput {...props} />;
  }
}
