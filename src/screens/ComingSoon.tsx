export function ComingSoon({ title, text }: { title: string; text: string }) {
  return (
    <div className="grid h-full place-items-center px-4 py-10">
      <div className="max-w-sm text-center">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{text}</p>
      </div>
    </div>
  );
}
