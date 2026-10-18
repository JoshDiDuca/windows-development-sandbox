// xterm.js filling its area: fits on resize, sends keystrokes, shows the session's output. Terminal text goes only to
// xterm (no HTML); links in it open after a confirmation and clipboard writes (OSC 52) are not handled at all. The
// page drives it through a handle: search, font size, keys from the on-screen key row, focus.
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useComputedColorScheme } from '@mantine/core';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { TerminalConnection, type ConnectionState } from './connection';

const DARK = {
  background: '#0e1015',
  foreground: '#e6e8ee',
  cursor: '#e6e8ee',
  selectionBackground: '#3b4252',
  black: '#1a1d24',
  brightBlack: '#6c7383',
};
const LIGHT = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#1f2328',
  selectionBackground: '#c7d2fe',
  black: '#1f2328',
  brightBlack: '#6e7781',
};

export const FONT_SIZES = [11, 12, 13, 14, 15, 16, 18, 20] as const;
/** A terminal in a hidden tab lets go of its session after this long. */
const HIDDEN_RELEASE_MS = 2 * 60_000;

export interface TerminalHandle {
  /** Finds text in the scrollback, forwards or backwards; false when there is none. */
  find(text: string, backwards?: boolean): boolean;
  clearFind(): void;
  /** Types these bytes into the session (the key row). */
  type(text: string): void;
  setFontSize(size: number): void;
  focus(): void;
}

interface TerminalViewProps {
  readonly sessionId: string;
  readonly fontSize: number;
  readonly onState: (state: ConnectionState, detail?: string) => void;
  /** Called with a function that ends the connection (detach). */
  readonly onReady: (detach: () => void) => void;
}

function openLink(_event: MouseEvent, uri: string): void {
  if (!/^https?:\/\//i.test(uri)) return;
  if (window.confirm('Open this link in a new tab?\n\n' + uri.slice(0, 300)))
    window.open(uri, '_blank', 'noopener,noreferrer');
}

export const TerminalView = forwardRef<TerminalHandle, TerminalViewProps>(function TerminalView(
  { sessionId, fontSize, onState, onReady },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const send = useRef<(text: string) => void>(() => undefined);
  // Dark or light follows the app (which follows the operating system or the toggle).
  const dark = useComputedColorScheme('dark') === 'dark';
  const startDark = useRef(dark);
  const startSize = useRef(fontSize);

  useImperativeHandle(
    ref,
    () => ({
      find: (text, backwards = false) =>
        backwards ? (search.current?.findPrevious(text) ?? false) : (search.current?.findNext(text) ?? false),
      clearFind: () => search.current?.clearDecorations(),
      type: (text) => send.current(text),
      setFontSize: (size) => {
        if (!terminal.current) return;
        terminal.current.options.fontSize = size;
        fit.current?.fit();
      },
      focus: () => terminal.current?.focus(),
    }),
    [],
  );

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const fitter = new FitAddon();
    const finder = new SearchAddon();
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, Menlo, monospace',
      fontSize: startSize.current,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: startDark.current ? DARK : LIGHT,
      linkHandler: { activate: openLink },
    });
    term.loadAddon(fitter);
    term.loadAddon(finder);
    term.loadAddon(new WebLinksAddon(openLink));
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(element);
    // Ctrl+C with text selected copies it, as everywhere else; without a selection it reaches the program.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'c') return true;
      if (!term.hasSelection()) return true;
      void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined);
      term.clearSelection();
      return false;
    });
    terminal.current = term;
    search.current = finder;
    fit.current = fitter;
    fitter.fit();

    const connection = new TerminalConnection(sessionId, {
      state: onState,
      output: (bytes) => term.write(bytes),
      reset: () => term.reset(),
    });
    const encoder = new TextEncoder();
    send.current = (text) => connection.send(encoder.encode(text));
    term.onData((text) => connection.send(encoder.encode(text)));
    term.onBinary((text) => connection.send(Uint8Array.from(text, (ch) => ch.charCodeAt(0))));
    term.onResize(({ cols, rows }) => connection.resize(cols, rows));
    const observer = new ResizeObserver(() => fitter.fit());
    observer.observe(element);
    // A terminal nobody looks at lets go of the session after a while; it reconnects (and redraws) when shown again.
    // Closing the page closes it at once.
    let hiddenTimer: number | undefined;
    const onVisibility = (): void => {
      window.clearTimeout(hiddenTimer);
      if (document.hidden) hiddenTimer = window.setTimeout(() => connection.suspend(), HIDDEN_RELEASE_MS);
      else connection.resume();
    };
    const onPageHide = (): void => connection.close();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);

    onReady(() => connection.close());
    connection.open(term.cols, term.rows);
    term.focus();
    return () => {
      window.clearTimeout(hiddenTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      observer.disconnect();
      connection.close();
      term.dispose();
      terminal.current = null;
      search.current = null;
      fit.current = null;
      send.current = () => undefined;
    };
  }, [sessionId, onState, onReady]);

  useEffect(() => {
    if (terminal.current) terminal.current.options.theme = dark ? DARK : LIGHT;
  }, [dark]);

  return <div ref={host} className="terminal-host" />;
});
