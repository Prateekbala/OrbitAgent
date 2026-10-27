'use client';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
const plugins = [remarkGfm];
export function RichMessage({
  body,
  format = 'plain',
  mentions = [],
}: {
  body: string;
  format?: 'plain' | 'markdown' | undefined;
  mentions?: { id: string; name: string; kind: string }[] | undefined;
}) {
  if (format === 'plain') return <p className="plain-message">{body}</p>;
  return (
    <div className="rich-message">
      <Markdown
        remarkPlugins={plugins}
        skipHtml
        disallowedElements={['img', 'input']}
        urlTransform={(url) =>
          /^mention:[0-9a-f-]{36}$/i.test(url) ? url : defaultUrlTransform(url)
        }
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith('mention:')) {
              const member = mentions.find((m) => m.id === href.slice(8));
              return (
                <span className="structured-mention" data-membership-id={href.slice(8)}>
                  {member ? '@' + member.name : children}
                  {member?.kind === 'agent' ? <small> agent</small> : null}
                </span>
              );
            }
            return href && /^https?:\/\//i.test(href) ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
        }}
      >
        {body}
      </Markdown>
    </div>
  );
}
