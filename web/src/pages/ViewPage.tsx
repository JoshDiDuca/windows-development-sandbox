// A page that is a view: its queries read over RPC (live ones kept fresh), its Page built in the browser by the view's
// own pure build() and drawn by PageView. A view with tabs (Settings: all projects / this project) gets them above it.
import { SegmentedControl } from '@mantine/core';
import { viewById } from '../../../src/app/features/defs';
import { viewInputs, type AnyView } from '../../../src/app/kernel/index';
import { PageView } from '../render/PageView';
import { ErrorState, PageSkeleton } from '../render/states';
import { useQueryData } from '../rpc/hooks';
import { navigate, viewPath } from '../router';

interface ViewPageProps {
  readonly view: string;
  readonly params: Readonly<Record<string, string>>;
}

/** A parameter taken from the address as it is: strings only, at most 200 characters. */
const MAX_PARAM = 200;

/** The view's parameters: the tab chosen (or its first), and the ones it takes from the address, from the address. */
function paramsOf(view: AnyView, given: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of (view.params as readonly string[] | undefined) ?? []) {
    const value = given[name];
    if (typeof value === 'string' && value.length <= MAX_PARAM) out[name] = value;
  }
  const tabs = view.tabs;
  if (!tabs) return out;
  const chosen = given[tabs.param];
  return { ...out, [tabs.param]: tabs.choices.some((c) => c.value === chosen) ? chosen : tabs.choices[0].value };
}

function LoadedView({ view, params }: { readonly view: AnyView; readonly params: Record<string, string> }) {
  const inputs = viewInputs(view, params as never) as Record<string, unknown>;
  const names = Object.keys(view.queries);
  // The same queries on every render of one view (the page is keyed by the view and its parameters).
  const results = names.map((name) => [name, useQueryData(view.queries[name], inputs[name])] as const);
  const failed = results.find(([, r]) => r.error);
  if (failed) {
    const error = failed[1].error as Error & { fix?: string };
    return <ErrorState message={error.message} fix={error.fix} retry={() => location.reload()} />;
  }
  if (results.some(([, r]) => r.pending)) return <PageSkeleton />;
  const page = view.build(Object.fromEntries(results.map(([name, r]) => [name, r.data])) as never, params as never);
  const tabs = view.tabs;
  const toolbar = tabs ? (
    <SegmentedControl
      size="sm"
      data={tabs.choices.map((c) => ({ value: c.value, label: c.label }))}
      value={params[tabs.param]}
      onChange={(value) => navigate(viewPath(view.id, { [tabs.param]: value }))}
    />
  ) : undefined;
  return <PageView page={page} summary={view.summary} toolbar={toolbar} />;
}

export function ViewPage({ view: id, params }: ViewPageProps) {
  const view = viewById(id);
  if (!view) return <ErrorState message={'There is no page called ' + id + '.'} fix="Pick a page on the left." />;
  const p = paramsOf(view, params);
  return <LoadedView key={id + JSON.stringify(p)} view={view} params={p} />;
}
