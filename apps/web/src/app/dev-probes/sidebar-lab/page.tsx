import { notFound } from 'next/navigation';

import { SidebarLab } from './sidebar-lab';

export default async function SidebarLabPage({
  searchParams,
}: {
  searchParams: Promise<{ icon?: string }>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { icon } = await searchParams;
  return (
    <SidebarLab
      initialIcon={
        icon === 'none' || icon === 'arrow' || icon === 'list' || icon === 'bubbles' ? icon : 'dots'
      }
    />
  );
}
