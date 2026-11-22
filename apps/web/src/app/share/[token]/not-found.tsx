import { AuthPanel, AuthHeader, AuthTitle, AuthDescription } from '@oat/ui/components/auth-layout';

/**
 * Any share link that doesn't resolve: unknown, turned off, reset or in the trash. One message for all,
 * so a link never reveals whether a document exists.
 */
export default function ShareNotFound() {
  return (
    <div
      className="flex min-h-[calc(100svh-3.5rem)] items-center justify-center px-6 py-12"
      data-share-missing=""
    >
      <AuthPanel className="w-full max-w-[22.5rem]">
        <AuthHeader>
          <AuthTitle>
            <h1>This link isn’t available</h1>
          </AuthTitle>
          <AuthDescription>
            It may have been turned off or replaced with a new link. Ask the person who shared it
            for an up-to-date one.
          </AuthDescription>
        </AuthHeader>
      </AuthPanel>
    </div>
  );
}
