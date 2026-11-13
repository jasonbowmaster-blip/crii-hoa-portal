import { NavLink } from 'react-router-dom';
import './board.css';

const LINKS = [
  { to: '/board', label: 'Overview', end: true },
  { to: '/board/inbox', label: 'Inbox' },
  { to: '/board/lots', label: 'Lots' },
  { to: '/board/checks', label: 'Checks' },
  { to: '/board/bill-run', label: 'Bill run' },
  { to: '/board/post', label: 'Post' },
];

// Header shared by every board screen: eyebrow, title, scrollable nav, link home.
export default function BoardHeader({ title }: { title: string }) {
  return (
    <>
      <p className="eyebrow eyebrow--board">Board only</p>
      <h1 className="title">{title}</h1>
      <nav className="board-nav" aria-label="Board sections">
        {LINKS.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end}>{l.label}</NavLink>
        ))}
      </nav>
      <p className="sub"><NavLink to="/">See the owner home screen</NavLink></p>
    </>
  );
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong. Please try again.';
}
