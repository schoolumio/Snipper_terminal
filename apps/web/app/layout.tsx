import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sniper Terminal',
  description: 'Multi-agent token pipeline, risk controls and execution console.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: '#05070a', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
