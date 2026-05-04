import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '9BizClaw License Manager',
  description: 'Manage license keys for 9BizClaw customers',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  )
}
