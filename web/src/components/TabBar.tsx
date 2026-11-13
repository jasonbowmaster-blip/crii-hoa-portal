import { NavLink } from 'react-router-dom';

const TABS = [
  { to: '/', label: 'Home', end: true },
  { to: '/bill', label: 'My bill', end: false },
  { to: '/documents', label: 'Documents', end: false },
  { to: '/message', label: 'Message', end: false },
];

export default function TabBar() {
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end}>{t.label}</NavLink>
      ))}
    </nav>
  );
}
