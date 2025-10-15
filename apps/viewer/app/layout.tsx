export const metadata = {
  title: 'PDF Markbook Viewer',
  description: 'View and navigate marked regions in PDF documents',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}