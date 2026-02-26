export function Settings() {
  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">
          Manage your team, integrations, and account preferences.
        </p>
      </div>

      <div className="space-y-8">
        {/* Team section */}
        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-slate-900">Team</h2>
          <p className="mt-1 text-sm text-slate-500">
            Invite team members and manage roles.
          </p>
          <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
            Team management coming soon.
          </div>
        </section>

        {/* Integrations section */}
        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-slate-900">Integrations</h2>
          <p className="mt-1 text-sm text-slate-500">
            Connect GitHub, Jira, and other tools.
          </p>
          <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
            Integration settings coming soon.
          </div>
        </section>

        {/* Account section */}
        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-slate-900">Account</h2>
          <p className="mt-1 text-sm text-slate-500">
            Update your profile and account preferences.
          </p>
          <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">
            Account settings coming soon.
          </div>
        </section>
      </div>
    </>
  );
}
