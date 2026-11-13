import { Fragment } from 'react'
import { parseInline, parseMarkdown } from '../issue-markdown'

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((token, index) => {
        if (token.kind === 'code') {
          return (
            <code
              key={index}
              className="rounded bg-black/[0.05] px-1 py-0.5 font-mono text-[11px] text-apple-text"
            >
              {token.text}
            </code>
          )
        }
        if (token.kind === 'strong') {
          return (
            <strong key={index} className="font-semibold">
              {token.text}
            </strong>
          )
        }
        if (token.kind === 'em') {
          return <em key={index}>{token.text}</em>
        }
        if (token.kind === 'link') {
          return (
            <a
              key={index}
              href={token.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-apple-blueInk underline decoration-black/[0.15] underline-offset-2 hover:decoration-apple-blue focus:outline-none focus-visible:ring-2 focus-visible:ring-apple-blue/50"
            >
              {token.text}
            </a>
          )
        }
        return <Fragment key={index}>{token.text}</Fragment>
      })}
    </>
  )
}

/**
 * Safe Markdown view for issue bodies / comments (#110).
 * Raw HTML in the source is rendered as text because every token becomes a
 * React node — there is no `dangerouslySetInnerHTML`.
 */
export function IssueMarkdown({ source }: { source: string | null }) {
  if (!source || !source.trim()) {
    return <p className="text-[13px] leading-relaxed text-apple-subtext">无正文</p>
  }
  return (
    <div className="space-y-2.5 text-[13px] leading-relaxed text-apple-text">
      {parseMarkdown(source).map((block, index) => {
        if (block.kind === 'heading') {
          const size = block.level === 1 ? 'text-[17px]' : block.level === 2 ? 'text-[15px]' : 'text-[13.5px]'
          return (
            <p key={index} className={`${size} font-semibold leading-snug text-apple-text`}>
              <Inline text={block.text} />
            </p>
          )
        }
        if (block.kind === 'list') {
          return (
            <ul
              key={index}
              className={`space-y-1 pl-5 ${block.ordered ? 'list-decimal' : 'list-disc'} marker:text-apple-subtext`}
            >
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} className="whitespace-pre-line">
                  <Inline text={item} />
                </li>
              ))}
            </ul>
          )
        }
        if (block.kind === 'quote') {
          return (
            <blockquote
              key={index}
              className="whitespace-pre-line border-l-2 border-apple-line pl-3 text-apple-subtext"
            >
              <Inline text={block.text} />
            </blockquote>
          )
        }
        if (block.kind === 'code') {
          return (
            <pre
              key={index}
              className="overflow-x-auto rounded-lg bg-black/[0.04] p-3 text-[11.5px] leading-relaxed"
            >
              <code className="font-mono text-apple-text">{block.text}</code>
            </pre>
          )
        }
        return (
          <p key={index} className="whitespace-pre-line">
            <Inline text={block.text} />
          </p>
        )
      })}
    </div>
  )
}
