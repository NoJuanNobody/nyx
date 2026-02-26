import { DocumentList } from '../components/DocumentList';

export function Dashboard() {
  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Documents</h1>
        <p className="mt-1 text-sm text-slate-500">
          Manage your documentation and keep it in sync with your codebase.
        </p>
      </div>

      <DocumentList />
    </>
  );
}
