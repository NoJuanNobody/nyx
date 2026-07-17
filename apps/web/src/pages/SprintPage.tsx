import { SprintGatekeeper } from '../components/SprintGatekeeper';

export function SprintPage() {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Sprint Gatekeeper</h1>
        <p className="mt-1 text-sm text-slate-500">
          Review sprint capacity and manage trade-offs before adding new specs to the queue.
        </p>
      </div>
      <SprintGatekeeper />
    </div>
    </div>
  );
}
