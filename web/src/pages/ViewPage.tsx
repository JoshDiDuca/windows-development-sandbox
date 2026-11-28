// A page that is a view: its queries read over RPC (live ones kept fresh), its Page built in the browser by the view's
// own pure build() and drawn by PageView. A view with tabs (Settings: all projects / this project) gets them above it,
// and a view with filters (what kind, which period) a small choice for each.
// Views a navigation entry embeds (Settings: VPN, GitHub) are more categories of that entry's page; their own address
// opens that page at their category.
import { SegmentedControl, Select } from '@mantine/core';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { embeddingOf, NAV, navGroupOf, navSections, viewById } from '../../../src/app/features/defs';
import { viewInputs, type AnyView, type ErrorAction } from '../../../src/app/kernel/index';
import { useAct } from '../render/actions';
import { PageView } from '../render/PageView';
import { ErrorState, PageSkeleton } from '../render/states';
import { useQueryData, type QueryData } from '../rpc/hooks';
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
  // A filter's value is one of its choices (else its first), like a tab's.
  for (const filter of view.filters ?? []) {
    const chosen = given[filter.param];
    out[filter.param] = filter.choices.some((c) => c.value === chosen) ? chosen : filter.choices[0].value;
  }
  const tabs = view.tabs;
  if (!tabs) return out;
  const chosen = given[tabs.param];
  return { ...out, [tabs.param]: tabs.choices.some((c) => c.value === chosen) ? chosen : tabs.choices[0].value };
}

/** The view's filters as small choices; picking one keeps the view's other parameters. */
function FilterChoices({ view, params }: { readonly view: AnyView; readonly params: Record<string, string> }) {
  return (
    <>
      {(view.filters ?? []).map((f) => (
        <Select
          key={f.param}
          size="sm"
          w={150}
          aria-label={f.label}
          allowDeselect={false}
          comboboxProps={{ withinPortal: true }}
          data={f.choices.map((c) => ({ value: c.value, label: c.label }))}
          value={params[f.param]}
          onChange={(value) => value && navigate(viewPath(view.id, { ...params, [f.param]: value }))}
        />
      ))}
    </>
  );
}

interface LoadedViewProps {
  readonly view: AnyView;
  readonly params: Record<string, string>;
  /** More categories for a page with categories: other views drawn in its place (CategoryPage extras). */
  readonly extras?: readonly { readonly id: string; readonly label: string; readonly node: ReactNode }[];
}

function QuerySlot({
  name,
  def,
  input,
  onResult,
}: {
  readonly name: string;
  readonly def: AnyView['queries'][string];
  readonly input: unknown;
  readonly onResult: (name: string, result: QueryData) => void;
}) {
  const result = useQueryData(def, input);
  useEffect(() => onResult(name, result), [name, result.data, result.error, result.pending, onResult]);
  return null;
}

function LoadedView({ view, params, extras }: LoadedViewProps) {
  const paramKey = JSON.stringify(params);
  const stableParams = useMemo(() => params, [paramKey]);
  const inputs = viewInputs(view, stableParams as never) as Record<string, unknown>;
  const names = Object.keys(view.queries);
  const [resultsByName, setResultsByName] = useState<Record<string, QueryData>>({});
  const onResult = useCallback((name: string, result: QueryData): void => {
    setResultsByName((current) => {
      const previous = current[name];
      if (previous?.data === result.data && previous?.error === result.error && previous?.pending === result.pending)
        return current;
      return { ...current, [name]: result };
    });
  }, []);
  const results = names.map(
    (name) => [name, resultsByName[name] ?? { data: undefined, error: null, pending: true }] as const,
  );
  const act = useAct();
  const failed = results.find(([, r]) => r.error);
  const pending = results.some(([, r]) => r.pending);
  const pageData = Object.fromEntries(results.map(([name, r]) => [name, r.data]));
  const page = useMemo(
    () => (pending || failed ? undefined : view.build(pageData as never, stableParams as never)),
    [view, stableParams, pending, failed?.[1].error, ...results.map(([, r]) => r.data)],
  );
  const querySlots = names.map((name) => (
    <QuerySlot key={name} name={name} def={view.queries[name]} input={inputs[name]} onResult={onResult} />
  ));
  if (failed) {
    const error = failed[1].error as Error & { fix?: string; action?: ErrorAction };
    const fixAction = error.action && {
      label: error.action.label,
      run: () =>
        void act({
          kind: 'operation',
          op: error.action!.op,
          input: error.action!.input ?? {},
          label: error.action!.label,
        }),
    };
    return <ErrorState message={error.message} fix={error.fix} fixAction={fixAction} retry={() => location.reload()} />;
  }
  if (pending || !page)
    return (
      <>
        {querySlots}
        <PageSkeleton />
      </>
    );
  const tabs = view.tabs;
  const filters = view.filters?.length ? <FilterChoices view={view} params={params} /> : null;
  const toolbar =
    tabs || filters ? (
      <>
        {filters}
        {tabs && (
          <SegmentedControl
            size="sm"
            data={tabs.choices.map((c) => ({ value: c.value, label: c.label }))}
            value={params[tabs.param]}
            onChange={(value) => navigate(viewPath(view.id, { [tabs.param]: value }))}
          />
        )}
      </>
    ) : undefined;
  const eyebrow = navGroupOf(NAV, view.id)?.label;
  return (
    <>
      {querySlots}
      <PageView page={page} summary={view.summary} eyebrow={eyebrow} toolbar={toolbar} extras={extras} />
    </>
  );
}

/** A view drawn as a category of another page: its own Page, without tabs of its own. */
function EmbeddedView({ id }: { readonly id: string }) {
  const view = viewById(id);
  if (!view) return null;
  return <LoadedView view={view} params={paramsOf(view, {})} />;
}

export function ViewPage({ view: id, params }: ViewPageProps) {
  const host = embeddingOf(NAV, id);
  useEffect(() => {
    // An embedded view's own address opens the page that shows it, at its category (#vpn).
    if (host?.view) navigate(viewPath(host.view) + '#' + id);
  }, [host, id]);
  if (host?.view) return <PageSkeleton />;
  const view = viewById(id);
  if (!view)
    return (
      <ErrorState
        message="Page not found"
        fix={'There is no page called “' + id + '”. Check the address, or pick a page from the sidebar.'}
      />
    );
  const p = paramsOf(view, params);
  const embeds = navSections(NAV).find((n) => n.view === id)?.embeds ?? [];
  const extras = embeds.map((e) => ({ id: e.view, label: e.label, node: <EmbeddedView id={e.view} /> }));
  return <LoadedView key={id + JSON.stringify(p)} view={view} params={p} extras={extras.length ? extras : undefined} />;
}
