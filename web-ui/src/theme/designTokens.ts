import { makeStyles, shorthands, tokens } from '@fluentui/react-components';

/**
 * Design tokens for consistent spacing, sizing, and visual properties
 * These complement Fluent UI's built-in tokens with app-specific values
 */

// Spacing scale (in pixels, converted to rem where needed)
export const spacing = {
  xxs: '4px',
  xs: '8px',
  sm: '12px',
  md: '16px',
  lg: '24px',
  xl: '32px',
  xxl: '48px',
} as const;

// Border radius scale
export const borderRadius = {
  sm: '4px',
  md: '8px',
  lg: '12px',
  xl: '16px',
  round: '9999px',
} as const;

// Shadow definitions (for custom use outside Fluent components)
export const shadows = {
  sm: '0 1px 2px rgba(0, 0, 0, 0.3)',
  md: '0 4px 8px rgba(0, 0, 0, 0.3)',
  lg: '0 8px 16px rgba(0, 0, 0, 0.3)',
  xl: '0 16px 32px rgba(0, 0, 0, 0.3)',
} as const;

// Font sizes
export const fontSizes = {
  xs: '11px',
  sm: '12px',
  md: '14px',
  lg: '16px',
  xl: '20px',
  xxl: '24px',
  xxxl: '32px',
} as const;

// Font weights
export const fontWeights = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

// Z-index scale
export const zIndex = {
  dropdown: 100,
  modal: 200,
  popover: 300,
  toast: 400,
  tooltip: 500,
} as const;

// Transition durations
export const transitions = {
  fast: '150ms',
  normal: '200ms',
  slow: '300ms',
} as const;

// Breakpoints
export const breakpoints = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  xxl: 1536,
} as const;

/**
 * Common style patterns as makeStyles factories
 * Use these for consistent styling across components
 */
export const useCommonStyles = makeStyles({
  // Flex utilities
  flexCenter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  flexBetween: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  flexColumn: {
    display: 'flex',
    flexDirection: 'column',
  },
  flexGap: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
  },

  // Card-like surface
  surface: {
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.borderRadius(borderRadius.md),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
  },

  // Elevated surface (for modals, dropdowns)
  surfaceElevated: {
    backgroundColor: tokens.colorNeutralBackground3,
    ...shorthands.borderRadius(borderRadius.md),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    boxShadow: tokens.shadow16,
  },

  // Text truncation
  truncate: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },

  // Full width
  fullWidth: {
    width: '100%',
  },

  // Interactive hover
  hoverEffect: {
    transition: `all ${transitions.fast} ease-in-out`,
    ':hover': {
      backgroundColor: tokens.colorSubtleBackgroundHover,
    },
  },
});
