import { config } from '../config';

export default function ContactFooter() {
  return (
    <p className="notice">
      Questions? <a href={`mailto:${config.boardEmail}`}>{config.boardEmail}</a> · {config.phone}
    </p>
  );
}
