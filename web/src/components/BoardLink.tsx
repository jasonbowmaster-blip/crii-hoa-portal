import { Link } from 'react-router-dom';
import { useSession } from '../session';

// Shown only to active board members.
export default function BoardLink() {
  const { session } = useSession();
  if (!session?.board) return null;
  return <Link to="/board" className="btn btn--block">Board view</Link>;
}
