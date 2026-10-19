// A page that is a view: its queries read over RPC (live ones kept fresh), its Page built in the browser by the view's
// own pure build() and drawn by PageView. A view with tabs (Settings: all projects / this project) gets them above it,
// and a view with filters (what kind, which period) a small choice for each.
// Views a navigation entry embeds (Settings: VPN, GitHub) are more categories of that entry's page; their own address
// opens that page at their category.
import { SegmentedControl, Select } from '@mantine/core';
import { useEffect, type ReactNode } from 'react';
import { embeddingOf, NAV, navSections, viewById } from '../../../src/app/features/defs';
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

function LoadedView({ view, params, extras }: LoadedViewProps) {
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
  return <PageView page={page} summary={view.summary} toolbar={toolbar} extras={extras} />;
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
  if (!view) return <ErrorState message={'There is no page called ' + id + '.'} fix="Pick a page on the left." />;
  const p = paramsOf(view, params);
  const embeds = navSections(NAV).find((n) => n.view === id)?.embeds ?? [];
  const extras = embeds.map((e) => ({ id: e.view, label: e.label, node: <EmbeddedView id={e.view} /> }));
  return <LoadedView key={id + JSON.stringify(p)} view={view} params={p} extras={extras.length ? extras : undefined} />;
}
