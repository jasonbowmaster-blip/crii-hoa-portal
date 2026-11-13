import { useState } from 'react';
import type { FormEvent } from 'react';
import { getApi } from '../../data/api';
import { FOLDER_LABELS } from '../../data/types';
import type { Audience, DocumentFolder, EventKind } from '../../data/types';
import BoardHeader, { errorText } from './BoardNav';

const EVENT_KINDS: Record<EventKind, string> = {
  board_meeting: 'Board meeting', annual_meeting: 'Annual meeting', tree_work: 'Tree work', dues_date: 'Dues date', other: 'Other',
};

// Each form keeps its own result line so a confirmation never lands under the wrong form.
function useResult() {
  const [ok, setOk] = useState('');
  const [err, setErr] = useState('');
  return { ok, err, setOk, setErr };
}

function Result({ r }: { r: ReturnType<typeof useResult> }) {
  return (
    <>
      <p className="board-ok" aria-live="polite">{r.ok}</p>
      <p className="error" role="alert" hidden={!r.err}>{r.err}</p>
    </>
  );
}

function AnnouncementForm() {
  const r = useResult();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<Audience>('owners');
  async function submit(e: FormEvent) {
    e.preventDefault(); r.setOk(''); r.setErr('');
    try {
      await getApi().postAnnouncement({ title: title.trim(), body: body.trim(), audience });
      r.setOk('Announcement posted.'); setTitle(''); setBody('');
    } catch (x) { r.setErr(errorText(x)); }
  }
  return (
    <form className="card board-form" onSubmit={submit} aria-labelledby="h-ann">
      <h2 className="row__title" id="h-ann">Post an announcement</h2>
      <label className="field">Title<input className="input" required value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field">Message<textarea className="input" required rows={4} value={body} onChange={(e) => setBody(e.target.value)} /></label>
      <label className="field">Who can see it
        <select className="input" value={audience} onChange={(e) => setAudience(e.target.value as Audience)}>
          <option value="owners">Owners</option><option value="public">Public</option>
        </select>
      </label>
      <button type="submit" className="btn btn--primary">Post announcement</button>
      <Result r={r} />
    </form>
  );
}

function DocumentForm() {
  const r = useResult();
  const [folder, setFolder] = useState<DocumentFolder>('governing');
  const [title, setTitle] = useState('');
  const [audience, setAudience] = useState<Audience>('owners');
  const [draft, setDraft] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault(); r.setOk(''); r.setErr('');
    try {
      await getApi().addDocument({ folder, title: title.trim(), audience, file, is_draft: draft });
      r.setOk('Document added.'); setTitle(''); setFile(null);
    } catch (x) { r.setErr(errorText(x)); }
  }
  return (
    <form className="card board-form" onSubmit={submit} aria-labelledby="h-doc">
      <h2 className="row__title" id="h-doc">Add a document</h2>
      <label className="field">Folder
        <select className="input" value={folder} onChange={(e) => setFolder(e.target.value as DocumentFolder)}>
          {(Object.keys(FOLDER_LABELS) as DocumentFolder[]).map((f) => <option key={f} value={f}>{FOLDER_LABELS[f]}</option>)}
        </select>
      </label>
      <label className="field">Title<input className="input" required value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field">Who can see it
        <select className="input" value={audience} onChange={(e) => setAudience(e.target.value as Audience)}>
          <option value="owners">Owners</option><option value="public">Public</option><option value="board">Board only</option>
        </select>
      </label>
      <label className="board-check"><input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> This is a draft (owners see it marked Draft; choose Board only to hide it)</label>
      <label className="field">File<input className="input" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      <button type="submit" className="btn btn--primary">Add document</button>
      <Result r={r} />
    </form>
  );
}

function EventForm() {
  const r = useResult();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<EventKind>('board_meeting');
  const [startsAt, setStartsAt] = useState('');
  const [location, setLocation] = useState('');
  const [video, setVideo] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  async function submit(e: FormEvent) {
    e.preventDefault(); r.setOk(''); r.setErr('');
    try {
      await getApi().addEvent({
        title: title.trim(), kind, starts_at: new Date(startsAt).toISOString(),
        location: location.trim() || null, video_url: video.trim() || null, is_public: isPublic,
      });
      r.setOk('Event added to the calendar.'); setTitle('');
    } catch (x) { r.setErr(errorText(x)); }
  }
  return (
    <form className="card board-form" onSubmit={submit} aria-labelledby="h-evt">
      <h2 className="row__title" id="h-evt">Add an event</h2>
      <label className="field">Title<input className="input" required value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="field">Kind
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value as EventKind)}>
          {(Object.keys(EVENT_KINDS) as EventKind[]).map((k) => <option key={k} value={k}>{EVENT_KINDS[k]}</option>)}
        </select>
      </label>
      <label className="field">Date and time<input className="input" type="datetime-local" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></label>
      <label className="field">Location<input className="input" value={location} onChange={(e) => setLocation(e.target.value)} /></label>
      <label className="field">Video link<input className="input" type="url" value={video} onChange={(e) => setVideo(e.target.value)} /></label>
      <label className="board-check"><input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} /> Show on the public calendar</label>
      <button type="submit" className="btn btn--primary">Add event</button>
      <Result r={r} />
    </form>
  );
}

export default function BoardPost() {
  return (
    <main className="page">
      <BoardHeader title="Post" />
      <AnnouncementForm />
      <DocumentForm />
      <EventForm />
    </main>
  );
}
