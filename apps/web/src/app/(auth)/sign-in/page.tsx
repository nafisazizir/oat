import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@oat/ui/components/card';
import type { Metadata } from 'next';

import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

export default function SignInPage() {
  return (
    <div className="flex flex-col gap-6">
      <Card className="shadow-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">
            <h1>Welcome to Oat</h1>
          </CardTitle>
          <CardDescription>Sign in to your notes and workspaces.</CardDescription>
        </CardHeader>
        <CardContent>
          <SignInForm />
        </CardContent>
      </Card>
      <p className="px-6 text-center text-xs text-muted-foreground">
        New here? Signing in creates your personal workspace.
      </p>
    </div>
  );
}
