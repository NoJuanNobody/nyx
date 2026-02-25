import { Link } from 'react-router-dom';

export function Settings() {
  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <Link to="/" className="text-blue-600 hover:underline">
        Back to Dashboard
      </Link>
      <h1 className="mt-4 text-2xl font-bold text-gray-900">Settings</h1>
      <p className="mt-2 text-gray-600">Team and integration settings will go here.</p>
    </div>
  );
}
