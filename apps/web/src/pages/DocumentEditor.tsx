import { useParams, Link } from 'react-router-dom';

export function DocumentEditor() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <Link to="/" className="text-blue-600 hover:underline">
        Back to Dashboard
      </Link>
      <h1 className="mt-4 text-2xl font-bold text-gray-900">Document Editor</h1>
      <p className="mt-2 text-gray-600">Editing document: {id}</p>
    </div>
  );
}
