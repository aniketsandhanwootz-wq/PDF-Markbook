export const metadata = {
  title: 'PDF Viewer',
  description: 'Scrollable, zoomable viewer with marks',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* Prevent browser zooming the whole UI on mobile; keep zoom inside our canvas */}
      <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
      <body style={{ margin: 0, background: '#fff' }}>{children}</body>
    </html>
  );
}
