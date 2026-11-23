import { notFound } from 'next/navigation';

import { SidebarLab } from './sidebar-lab';

export default async function SidebarLabPage({
  searchParams,
}: {
  searchParams: Promise<{ v?: string }>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { v } = await searchParams;
  return <SidebarLab initialVariant={v === 'b2' || v === 'b3' || v === 'b4' ? v : 'b1'} />;
}
