import type {Metadata} from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css'; // Global styles

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'Foreman – AI Coffee Roasting Fault-Detection Assistant',
  description: 'An AI-powered diagnostic and fault-detection tool for professional coffee roasters.',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="antialiased bg-[#06080b] text-[#94a3b8]" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
