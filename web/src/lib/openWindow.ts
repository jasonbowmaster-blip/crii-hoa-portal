// Open a file whose address has to be fetched first (a short-lived private link).
// Phones only allow window.open during the tap itself; after an await it is silently blocked. So the new tab is opened
// at once, empty, and pointed at the file when the address arrives. If the browser refuses the empty tab, the current
// tab goes to the file instead, which always works. On failure the empty tab is closed and the error is thrown.
export async function openWhenReady(getUrl: () => Promise<string>): Promise<void> {
  const win = window.open('', '_blank');
  if (win) {
    try { win.opener = null; } catch { /* some browsers forbid it; harmless */ }
    try { win.document.title = 'Opening…'; } catch { /* ignore */ }
  }
  let url: string;
  try { url = await getUrl(); }
  catch (e) { win?.close(); throw e; }
  if (win && !win.closed) win.location.href = url;
  else window.location.assign(url);
}
