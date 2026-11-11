import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "../lib/platform";

const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) void openUrl(href);
      }}
      className="font-medium text-brand-600 underline decoration-brand-600/30 underline-offset-2 hover:decoration-brand-600 dark:text-brand-400"
    >
      {children}
    </a>
  ),
  p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-5">{children}</ol>,
  h1: ({ children }) => <h1 className="mt-5 mb-2 text-xl font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-2 text-lg font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-zinc-300 pl-3 text-zinc-600 dark:border-zinc-600 dark:text-zinc-300">{children}</blockquote>
  ),
  hr: () => <hr className="my-4 border-zinc-200 dark:border-zinc-800" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-zinc-200 bg-zinc-50 px-3 py-2 font-semibold dark:border-zinc-800 dark:bg-zinc-800/50">{children}</th>,
  td: ({ children }) => <td className="border-b border-zinc-100 px-3 py-2 dark:border-zinc-800/60">{children}</td>,
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-xl bg-zinc-950 p-3.5 text-[13px] leading-relaxed text-zinc-100 dark:bg-black/60">{children}</pre>
  ),
  code: ({ className, children }) =>
    className || String(children).includes("\n") ? (
      <code className={`font-mono ${className}`}>{children}</code>
    ) : (
      <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.9em] dark:bg-zinc-800">{children as ReactNode}</code>
    ),
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="text-[15px] leading-relaxed break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
