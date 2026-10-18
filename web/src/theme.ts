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
  // A compact scale: 14 px body text, 13 px secondary text, headings that do not shout.
  fontSizes: { xs: '0.75rem', sm: '0.8125rem', md: '0.875rem', lg: '1rem', xl: '1.125rem' },
  lineHeights: { xs: '1.45', sm: '1.5', md: '1.55', lg: '1.55', xl: '1.5' },
  headings: {
    fontFamily: '"Segoe UI Variable Display", "Segoe UI", system-ui, -apple-system, sans-serif',
    fontWeight: '650',
    sizes: {
      h1: { fontSize: '1.375rem', lineHeight: '1.3' },
      h2: { fontSize: '1.125rem', lineHeight: '1.35' },
      h3: { fontSize: '0.9375rem', lineHeight: '1.4' },
    },
  },
  radius: { xs: '4px', sm: '6px', md: '8px', lg: '10px', xl: '14px' },
  defaultRadius: 'md',
  cursorType: 'pointer',
  focusRing: 'auto',
  components: {
    Card: Card.extend({ defaultProps: { withBorder: true, radius: 'lg', padding: 'md', shadow: 'none' } }),
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
    Switch: Switch.extend({ defaultProps: { size: 'sm' } }),
    TextInput: TextInput.extend({ defaultProps: { spellCheck: false } }),
  },
});
