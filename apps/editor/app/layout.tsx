export const metadata = {
  title: 'PDF Marker',
  description: 'Draw rectangles to make mark sets',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
      <body style={{ margin: 0, background: '#fff' }}>{children}</body>
    </html>
  );
}
