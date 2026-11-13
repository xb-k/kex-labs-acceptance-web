/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        apple: {
          bg: '#F5F5F7',
          text: '#1D1D1F',
          subtext: '#6E6E73',
          subtextAlt: '#6B6B70',
          blue: '#0071E3',
          blueInk: '#0062C4',
          purple: '#7D54C8',
          green: '#34C759',
          greenInk: '#1E7A3C',
          orange: '#C26A00',
          red: '#FF3B30',
          amber: '#B25000',
          line: '#E5E5EA',
          statusPending: '#8E8E93',
          statusRunning: '#0071E3',
          statusBlocked: '#C77700',
          statusDone: '#30A14E',
          accentBlue: '#0071E3',
          accentPurple: '#5E4AC7'
        }
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"SF Pro Display"',
          'Inter',
          '"PingFang SC"',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif'
        ],
        mono: ['"SF Mono"', '"JetBrains Mono"', 'ui-monospace', 'Menlo', 'Consolas', 'monospace']
      },
      fontSize: {
        page: ['32px', { lineHeight: '1.1', letterSpacing: '-0.024em', fontWeight: '600' }],
        section: ['15px', { lineHeight: '1.4', letterSpacing: '-0.012em', fontWeight: '600' }],
        subtitle: ['15px', { lineHeight: '1.5', letterSpacing: '-0.006em' }],
        body: ['14px', { lineHeight: '1.55' }],
        kpi: ['28px', { lineHeight: '1.05', letterSpacing: '-0.022em', fontWeight: '600' }]
      },
      boxShadow: {
        hairline: '0 0 0 1px rgba(17, 24, 39, 0.06)',
        soft: '0 1px 2px rgba(17, 24, 39, 0.04)',
        float: '0 8px 24px rgba(17, 24, 39, 0.08)',
        container: '0 4px 24px -4px rgba(0, 0, 0, 0.04), 0 1px 2px 0 rgba(0, 0, 0, 0.02)',
        nav: '0 1px 3px rgba(0, 0, 0, 0.06), 0 0 0 0.5px rgba(0, 0, 0, 0.04)',
        card: '0 1px 2px rgba(0, 0, 0, 0.04), 0 12px 32px rgba(0, 0, 0, 0.06)',
        lift: '0 2px 4px rgba(17, 24, 39, 0.05), 0 16px 40px rgba(17, 24, 39, 0.08)'
      },
      borderRadius: {
        card: '20px',
        panel: '14px'
      },
      transitionTimingFunction: {
        apple: 'cubic-bezier(0.2, 0.8, 0.2, 1)'
      },
      transitionDuration: {
        quick: '150ms',
        base: '180ms',
        enter: '240ms',
        panel: '380ms'
      }
    }
  },
  plugins: []
}
