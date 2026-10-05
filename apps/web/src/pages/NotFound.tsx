import { Link } from 'react-router-dom';

export default function NotFound(): JSX.Element {
  return (
    <div className="page narrow center">
      <h1>Page not found</h1>
      <p className="muted">The page you are looking for does not exist or has been removed.</p>
      <Link to="/" className="btn primary">
        Back to home
      </Link>
    </div>
  );
}
