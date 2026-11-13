import { useState } from 'react';
import { getApi } from '../../data/api';
import { FOLDER_LABELS, type DocumentFolder, type DocumentItem } from '../../data/types';
import { useAsync } from '../../components/useAsync';
import Page from '../../components/Page';
import StatusPill from '../../components/StatusPill';
import ContactFooter from '../../components/ContactFooter';
import { daysAgo, shortDate } from '../../components/dates';

export default function Documents() {
  const { data, error, loading } = useAsync(() => getApi().listDocuments());
  const [query, setQuery] = useState('');
  const [folder, setFolder] = useState<DocumentFolder | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const docs = data ?? [];
  const q = query.trim().toLowerCase();

  async function open(d: DocumentItem) {
    setOpenError(null);
    try { window.open(await getApi().openDocument(d.id), '_blank', 'noopener'); }
    catch { setOpenError('We could not open that document. Please try again.'); }
  }

  const list = (items: DocumentItem[]) => (
    <ul className="card" style={{ margin: 0, padding: '6px 18px' }}>
      {items.map((d) => (
        <li key={d.id} className="row" style={{ listStyle: 'none' }}>
          <button type="button" className="btn--link row__main" style={{ textAlign: 'left', border: 0, background: 'none', cursor: 'pointer', minHeight: 44 }} onClick={() => open(d)}>
            <span className="row__title">{d.title}</span>
            <span className="row__meta">{FOLDER_LABELS[d.folder]} · posted {shortDate(d.posted_on)}</span>
          </button>
          {d.is_draft && <StatusPill status="draft" />}
        </li>
      ))}
    </ul>
  );

  const fresh = docs.filter((d) => daysAgo(d.posted_on) <= 30)
    .sort((a, b) => b.posted_on.localeCompare(a.posted_on)).slice(0, 3);
  const folders = Object.keys(FOLDER_LABELS) as DocumentFolder[];

  return (
    <Page title="Documents" loading={loading} error={error}>
      <label className="field">
        <span className="sr-only">Search documents</span>
        <input className="input" type="search" placeholder="Search documents" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {openError && <p className="error" role="alert">{openError}</p>}
      {q ? (
        <>
          <h2 className="section-label">Results</h2>
          {docs.filter((d) => d.title.toLowerCase().includes(q)).length
            ? list(docs.filter((d) => d.title.toLowerCase().includes(q)))
            : <p className="sub">No documents match that search.</p>}
        </>
      ) : folder ? (
        <>
          <button type="button" className="btn btn--link" onClick={() => setFolder(null)}>All folders</button>
          <h2 className="section-label">{FOLDER_LABELS[folder]}</h2>
          {docs.some((d) => d.folder === folder) ? list(docs.filter((d) => d.folder === folder)) : <p className="sub">Nothing in this folder yet.</p>}
        </>
      ) : (
        <>
          {fresh.length > 0 && (<><h2 className="section-label">New</h2>{list(fresh)}</>)}
          <h2 className="section-label">Folders</h2>
          <div className="grid-2">
            {folders.map((f) => (
              <button key={f} type="button" className="tile" onClick={() => setFolder(f)} style={{ cursor: 'pointer', textAlign: 'left' }}>
                {FOLDER_LABELS[f]}
                <span className="row__meta">{docs.filter((d) => d.folder === f).length} documents</span>
              </button>
            ))}
          </div>
        </>
      )}
      <ContactFooter />
    </Page>
  );
}
