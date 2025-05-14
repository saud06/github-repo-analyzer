import type { Config } from 'tailwindcss'
import daisyui from 'daisyui'

export default {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [daisyui],
  daisyui: {
    themes: [
      {
        githubish: {
          primary: '#0969da',
          'primary-content': '#ffffff',
          secondary: '#57606a',
          accent: '#1f883d',
          neutral: '#24292f',
          'base-100': '#ffffff',
          'base-200': '#f6f8fa',
          'base-300': '#d0d7de',
          info: '#0969da',
          success: '#1f883d',
          warning: '#9a6700',
          error: '#cf222e',
          '--rounded-box': '8px',
          '--rounded-btn': '6px',
          '--rounded-badge': '6px',
          '--border-btn': '1px',
          '--tab-border': '1px',
          '--tab-radius': '6px',
        },
      },
      {
        githubish_dark: {
          primary: '#1f6feb',
          'primary-content': '#ffffff',
          secondary: '#8b949e',
          accent: '#3fb950',
          neutral: '#161b22',
          'base-100': '#0d1117',
          'base-200': '#0b0f14',
          'base-300': '#30363d',
          info: '#58a6ff',
          success: '#3fb950',
          warning: '#d29922',
          error: '#f85149',
          '--rounded-box': '8px',
          '--rounded-btn': '6px',
          '--rounded-badge': '6px',
          '--border-btn': '1px',
          '--tab-border': '1px',
          '--tab-radius': '6px',
        },
      },
      'light',
    ],
  },
} satisfies Config
