export function FeaturePageHeader({
  kind,
  workspaceName,
}: {
  kind: 'tasks' | 'search';
  workspaceName: string;
}) {
  const name = workspaceName.trim() || 'this workspace';
  return (
    <header className="flex flex-col gap-2" data-testid="feature-page-header">
      <h1 className="text-heading-32 text-gray-1000">{kind === 'tasks' ? 'My tasks' : 'Search'}</h1>
      <p className="text-copy-16 text-gray-900">
        {kind === 'tasks'
          ? `Action items from meeting notes in ${name}.`
          : `Notes and transcripts in ${name}.`}
      </p>
    </header>
  );
}
