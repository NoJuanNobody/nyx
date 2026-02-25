import { Link } from 'react-router-dom';

export function Dashboard() {
  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <h1 className="text-3xl font-bold text-gray-900">SyncDocs</h1>
      <p className="mt-2 text-gray-600">Your documents will appear here.</p>
      <nav className="mt-6">
        <Link to="/settings" className="text-blue-600 hover:underline">
          Settings
        </Link>
      </nav>
    </div>
  );
}
