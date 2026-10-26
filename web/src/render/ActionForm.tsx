// An action with fields to fill in first (a setting's new value): a modal form of Field inputs, checked as you type by
// the operation's own input schema (@mantine/form + the zod resolver) and by what each Field knows (range, choices).
import { Button, Group, Stack } from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { zod4Resolver } from 'mantine-form-zod-resolver';
import { z } from 'zod';
import { operationById } from '../../../src/app/features/defs';
import { fieldProblem, type OperationAction } from '../../../src/app/kernel/index';
import { FieldInput } from './FieldInput';

type Values = Record<string, unknown>;

/** The part of the operation's input schema the fields fill in (the rest of the input is fixed by the action). */
function fieldSchema(action: OperationAction): z.ZodType<Values> | undefined {
  const input = operationById(action.op)?.input;
  const names = (action.fields ?? []).map((f) => f.name);
  if (!(input instanceof z.ZodObject) || !names.length) return undefined;
  const shape = input.shape as Record<string, z.ZodType>;
  return z.object(Object.fromEntries(names.filter((n) => shape[n]).map((n) => [n, shape[n]]))) as z.ZodType<Values>;
}

/** The submit button's words: "Save" for a value changed in place, else the action's own label ("Add an agent"). */
export function submitLabel(action: OperationAction): string {
  if (action.inline || !action.label) return 'Save';
  return action.label.replace(/\s*(…|\.\.\.)$/, '');
}

interface ActionFormProps {
  readonly action: OperationAction;
  readonly submit: (values: Values) => void;
  readonly cancel: () => void;
}

function ActionForm({ action, submit, cancel }: ActionFormProps) {
  const fields = action.fields ?? [];
  const schema = fieldSchema(action);
  const resolver = schema ? zod4Resolver(schema) : undefined;
  const form = useForm<Values>({
    mode: 'controlled',
    initialValues: { ...action.initial },
    validate: (values) => {
      const problems: Record<string, string> = {};
      for (const f of fields) {
        const problem = fieldProblem(f, values[f.name]);
        if (problem) problems[f.name] = problem;
      }
      return { ...(resolver ? resolver(values) : {}), ...problems };
    },
  });
  return (
    <form onSubmit={form.onSubmit(submit)}>
      <Stack gap="md">
        {fields.map((f) => (
          <FieldInput
            key={f.name}
            field={f}
            value={form.values[f.name]}
            error={form.errors[f.name] as string | undefined}
            onChange={(v) => form.setFieldValue(f.name, v)}
          />
        ))}
        <Group justify="flex-end">
          <Button variant="default" onClick={cancel}>
            Cancel
          </Button>
          <Button type="submit" color={action.danger ? 'red' : undefined}>
            {submitLabel(action)}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

/** Asks for an action's fields in a modal; resolves with the values, or undefined when cancelled. */
export function askFields(action: OperationAction): Promise<Values | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (values: Values | undefined): void => {
      if (settled) return;
      settled = true;
      modals.close(id);
      resolve(values);
    };
    const fields = action.fields ?? [];
    const id = modals.open({
      title: fields.length === 1 ? fields[0].label : action.label,
      centered: true,
      onClose: () => finish(undefined),
      children: <ActionForm action={action} submit={finish} cancel={() => finish(undefined)} />,
    });
  });
}
