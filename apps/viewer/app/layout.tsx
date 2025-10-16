export const metadata = {
  title: 'PDF Markbook Viewer',
  description: 'Mobile-friendly viewer for marked PDF regions',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Body never scrolls; only the PDF pane inside the app scrolls.
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: 0,
          height: '100vh',
          overflow: 'hidden',
          background: '#f6f7f9',
          WebkitFontSmoothing: 'antialiased',
          fontFamily:
            'Inter, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, "Helvetica Neue", Arial, sans-serif',
        }}
      >
        {children}
      </body>
    </html>
  );
}
