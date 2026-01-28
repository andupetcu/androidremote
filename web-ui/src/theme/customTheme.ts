import { createDarkTheme, type BrandVariants, type Theme } from '@fluentui/react-components';

/**
 * Android Remote brand colors based on the existing dark theme
 * Primary: #e94560 (pink/red accent)
 * Backgrounds: #1a1a2e, #16213e, #0f3460 (deep blues)
 */
const androidRemoteBrand: BrandVariants = {
  10: '#1a0a0d',
  20: '#2d1016',
  30: '#4a1520',
  40: '#6b1a2b',
  50: '#8d1f36',
  60: '#b32444',
  70: '#d42952',
  80: '#e94560', // Primary brand color
  90: '#ed6b80',
  100: '#f190a0',
  110: '#f5b5bf',
  120: '#f9dadf',
  130: '#fcedee',
  140: '#fef6f7',
  150: '#fff9fa',
  160: '#fffcfc',
};

// Create base dark theme from brand
const baseDarkTheme = createDarkTheme(androidRemoteBrand);

/**
 * Custom dark theme for Android Remote MDM
 * Overrides specific tokens to match the existing design system
 */
export const androidRemoteDarkTheme: Theme = {
  ...baseDarkTheme,

  // Background colors
  colorNeutralBackground1: '#1a1a2e', // Main page background
  colorNeutralBackground2: '#16213e', // Cards, sidebar
  colorNeutralBackground3: '#0f3460', // Elevated surfaces, table headers
  colorNeutralBackground4: '#0f3460',
  colorNeutralBackground5: '#1a1a2e',
  colorNeutralBackground6: '#16213e',

  // Subtle backgrounds
  colorSubtleBackground: 'transparent',
  colorSubtleBackgroundHover: 'rgba(233, 69, 96, 0.1)',
  colorSubtleBackgroundPressed: 'rgba(233, 69, 96, 0.2)',
  colorSubtleBackgroundSelected: 'rgba(233, 69, 96, 0.15)',

  // Text colors
  colorNeutralForeground1: '#eeeeee', // Primary text
  colorNeutralForeground2: '#888888', // Secondary text
  colorNeutralForeground3: '#666666', // Tertiary/disabled text
  colorNeutralForeground4: '#555555',
  colorNeutralForegroundDisabled: '#666666',

  // Brand colors (primary actions)
  colorBrandForeground1: '#e94560',
  colorBrandForeground2: '#ff6b6b',
  colorBrandBackground: '#e94560',
  colorBrandBackgroundHover: '#ff6b6b',
  colorBrandBackgroundPressed: '#d63d56',
  colorBrandBackgroundSelected: '#e94560',

  // Stroke/border colors
  colorNeutralStroke1: '#0f3460',
  colorNeutralStroke2: '#0f3460',
  colorNeutralStroke3: '#16213e',
  colorNeutralStrokeAccessible: '#0f3460',
  colorBrandStroke1: '#e94560',
  colorBrandStroke2: '#ff6b6b',

  // Compound brand (for filled buttons, etc.)
  colorCompoundBrandForeground1: '#e94560',
  colorCompoundBrandForeground1Hover: '#ff6b6b',
  colorCompoundBrandForeground1Pressed: '#d63d56',
  colorCompoundBrandBackground: '#e94560',
  colorCompoundBrandBackgroundHover: '#ff6b6b',
  colorCompoundBrandBackgroundPressed: '#d63d56',

  // Status colors
  colorPaletteRedBackground1: 'rgba(239, 68, 68, 0.1)',
  colorPaletteRedBackground2: 'rgba(239, 68, 68, 0.2)',
  colorPaletteRedBackground3: '#ef4444',
  colorPaletteRedForeground1: '#ef4444',
  colorPaletteRedForeground2: '#fca5a5',
  colorPaletteRedBorder1: '#ef4444',
  colorPaletteRedBorder2: '#dc2626',

  colorPaletteGreenBackground1: 'rgba(34, 197, 94, 0.1)',
  colorPaletteGreenBackground2: 'rgba(34, 197, 94, 0.2)',
  colorPaletteGreenBackground3: '#22c55e',
  colorPaletteGreenForeground1: '#22c55e',
  colorPaletteGreenForeground2: '#86efac',
  colorPaletteGreenBorder1: '#22c55e',
  colorPaletteGreenBorder2: '#16a34a',

  colorPaletteYellowBackground1: 'rgba(234, 179, 8, 0.1)',
  colorPaletteYellowBackground2: 'rgba(234, 179, 8, 0.2)',
  colorPaletteYellowBackground3: '#eab308',
  colorPaletteYellowForeground1: '#eab308',
  colorPaletteYellowForeground2: '#fde047',
  colorPaletteYellowBorder1: '#eab308',
  colorPaletteYellowBorder2: '#ca8a04',

  // Shadow (using existing dark theme shadow tokens)
  shadow2: '0 0 2px rgba(0,0,0,0.24), 0 1px 2px rgba(0,0,0,0.28)',
  shadow4: '0 0 2px rgba(0,0,0,0.24), 0 2px 4px rgba(0,0,0,0.28)',
  shadow8: '0 0 2px rgba(0,0,0,0.24), 0 4px 8px rgba(0,0,0,0.28)',
  shadow16: '0 0 2px rgba(0,0,0,0.24), 0 8px 16px rgba(0,0,0,0.28)',
  shadow28: '0 0 8px rgba(0,0,0,0.24), 0 14px 28px rgba(0,0,0,0.28)',
  shadow64: '0 0 8px rgba(0,0,0,0.24), 0 32px 64px rgba(0,0,0,0.28)',
};
