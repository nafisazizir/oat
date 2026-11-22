import { Button } from '@oat/ui/components/button';
import {
  AuthPanel,
  AuthHeader,
  AuthTitle,
  AuthDescription,
  AuthContent,
} from '@oat/ui/components/auth-layout';
import Link from 'next/link';

export default function AppNotFound() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-12">
      <AuthPanel className="w-full max-w-[22.5rem]">
        <AuthHeader>
          <AuthTitle>
            <h1>Page not found</h1>
          </AuthTitle>
          <AuthDescription>
            It may have been moved or deleted, or you might not have access to it.
          </AuthDescription>
        </AuthHeader>
        <AuthContent>
          <Button size="lg" role="link" nativeButton={false} render={<Link href="/home" />}>
            Go home
          </Button>
        </AuthContent>
      </AuthPanel>
    </div>
  );
}
