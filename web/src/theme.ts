// The web UI's look, in one place: Windows' own fonts, one accent (indigo), a cool neutral dark palette, and the
// defaults every component starts from (cards with a border, rounded corners, compact controls). Pages never set
// colours or sizes of their own: they use these and the tokens in app.css (docs/design/web-ui-standard.md).
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  createTheme,
  Menu,
  Modal,
  NavLink,
  Notification,
  Paper,
  SegmentedControl,
  Select,
  Switch,
  TextInput,
  Tooltip,
  type MantineColorsTuple,
} from '@mantine/core';

/** Cool greys for dark mode, from text (0) to the page behind everything (9). */
const dark: MantineColorsTuple = [
  '#e6e8ee',
  '#c4c8d2',
  '#9aa0ad',
  '#6c7383',
  '#4a5060',
  '#30343f',
  '#22252e',
  '#1a1d24',
  '#14161c',
  '#0e1015',
];

export const theme = createTheme({
  primaryColor: 'indigo',
  primaryShade: { light: 6, dark: 5 },
  colors: { dark },
  fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace: '"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, "SF Mono", Menlo, monospace',
  headings: {
    fontFamily: '"Segoe UI Variable Display", "Segoe UI", system-ui, -apple-system, sans-serif',
    fontWeight: '650',
    sizes: { h1: { fontSize: '1.625rem' }, h2: { fontSize: '1.375rem' }, h3: { fontSize: '1.0625rem' } },
  },
  defaultRadius: 'md',
  cursorType: 'pointer',
  focusRing: 'auto',
  components: {
    Card: Card.extend({ defaultProps: { withBorder: true, radius: 'lg', padding: 'lg', shadow: 'none' } }),
    Paper: Paper.extend({ defaultProps: { radius: 'lg' } }),
    Button: Button.extend({ defaultProps: { radius: 'md', size: 'sm' } }),
    ActionIcon: ActionIcon.extend({ defaultProps: { variant: 'subtle', color: 'gray', radius: 'md' } }),
    Badge: Badge.extend({ defaultProps: { radius: 'sm', variant: 'light', tt: 'none', fw: 600 } }),
    Tooltip: Tooltip.extend({ defaultProps: { withArrow: true, openDelay: 300, multiline: true, maw: 320 } }),
    Modal: Modal.extend({
      defaultProps: { radius: 'lg', centered: true, overlayProps: { blur: 2, backgroundOpacity: 0.45 } },
    }),
    Menu: Menu.extend({ defaultProps: { radius: 'md', shadow: 'md', withinPortal: true } }),
    NavLink: NavLink.extend({ defaultProps: { variant: 'light' } }),
    Notification: Notification.extend({ defaultProps: { radius: 'md', withBorder: true } }),
    SegmentedControl: SegmentedControl.extend({ defaultProps: { radius: 'md' } }),
    Select: Select.extend({ defaultProps: { allowDeselect: false, checkIconPosition: 'right' } }),
    Switch: Switch.extend({ defaultProps: { size: 'md' } }),
    TextInput: TextInput.extend({ defaultProps: { spellCheck: false } }),
  },
});
