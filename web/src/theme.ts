// The web UI's look, in one place: Windows' own fonts, one accent (indigo), a cool neutral dark palette, one type scale
// and one spacing scale, and the defaults every component starts from (cards with a hairline border and no shadow,
// compact controls). Pages never set colours or sizes of their own: they use these and the tokens in app.css
// (docs/design/web-ui-standard.md).
import {
  ActionIcon,
  Alert,
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
  '#e7e9ee',
  '#c5c9d3',
  '#9ba1ae',
  '#6d7484',
  '#4b5161',
  '#2f333d',
  '#21242c',
  '#191b22',
  '#13151a',
  '#0d0f13',
];

export const theme = createTheme({
  primaryColor: 'indigo',
  primaryShade: { light: 6, dark: 5 },
  colors: { dark },
  fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace: '"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, "SF Mono", Menlo, monospace',
  // The type scale: 12 / 13 / 14 / 16 / 18 px text; headings 24 / 18 / 15 px.
  fontSizes: { xs: '0.75rem', sm: '0.8125rem', md: '0.875rem', lg: '1rem', xl: '1.125rem' },
  lineHeights: { xs: '1.45', sm: '1.5', md: '1.55', lg: '1.55', xl: '1.5' },
  // The spacing scale: 4 / 8 / 12 / 16 / 24 / 32 px.
  spacing: { xs: '0.5rem', sm: '0.75rem', md: '1rem', lg: '1.5rem', xl: '2rem' },
  headings: {
    fontFamily: '"Segoe UI Variable Display", "Segoe UI", system-ui, -apple-system, sans-serif',
    fontWeight: '650',
    sizes: {
      h1: { fontSize: '1.5rem', lineHeight: '1.25' },
      h2: { fontSize: '1.125rem', lineHeight: '1.35' },
      h3: { fontSize: '0.9375rem', lineHeight: '1.4' },
    },
  },
  radius: { xs: '4px', sm: '6px', md: '8px', lg: '10px', xl: '14px' },
  defaultRadius: 'md',
  cursorType: 'pointer',
  focusRing: 'auto',
  respectReducedMotion: true,
  components: {
    Alert: Alert.extend({ defaultProps: { radius: 'md', variant: 'light' } }),
    Card: Card.extend({ defaultProps: { withBorder: true, radius: 'lg', padding: 'md', shadow: 'none' } }),
    Paper: Paper.extend({ defaultProps: { radius: 'lg' } }),
    Button: Button.extend({ defaultProps: { radius: 'md', size: 'sm' } }),
    ActionIcon: ActionIcon.extend({ defaultProps: { variant: 'subtle', color: 'gray', radius: 'md' } }),
    Badge: Badge.extend({ defaultProps: { radius: 'xl', variant: 'light', tt: 'none', fw: 600 } }),
    Tooltip: Tooltip.extend({ defaultProps: { withArrow: true, openDelay: 300, multiline: true, maw: 320 } }),
    Modal: Modal.extend({
      defaultProps: {
        radius: 'lg',
        centered: true,
        padding: 'lg',
        overlayProps: { blur: 2, backgroundOpacity: 0.4 },
        styles: { title: { fontWeight: 650, fontSize: 'var(--mantine-font-size-lg)' } },
      },
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
