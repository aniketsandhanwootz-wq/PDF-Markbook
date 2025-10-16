import './globals.css'

export const metadata = {
  title: 'PDF Markbook Viewer',
  description: 'View and navigate marked regions in PDF documents',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}