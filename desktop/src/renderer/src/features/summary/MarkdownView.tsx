import { memo, useMemo, type ReactNode } from 'react';
import { parseInline, parseMarkdown, type Inline } from '@shared/markdown';

function renderInline(nodes: Inline[], onCite: (ms: number) => void): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return node.text;
      case 'bold':
        return <strong key={i}>{renderInline(node.children, onCite)}</strong>;
      case 'italic':
        return <em key={i}>{renderInline(node.children, onCite)}</em>;
      case 'code':
        return <code key={i}>{node.text}</code>;
      case 'cite':
        return (
          <button key={i} type="button" className="cite tabular" aria-label={`Play source at ${node.label}`} onClick={() => onCite(node.ms)}>
            {node.label}
          </button>
        );
    }
  });
}

/**
 * Shows AI text as real elements built from parsed data, with no HTML injection anywhere, so nothing a
 * model writes can run or load anything. `dir="auto"` per block keeps mixed Urdu and English correct.
 */
export const MarkdownView = memo(function MarkdownView({ markdown, onCite }: { markdown: string; onCite: (ms: number) => void }) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  return (
    <div className="md selectable">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'heading': {
            const Tag = `h${Math.min(4, block.level + 1)}` as 'h2' | 'h3' | 'h4';
            return (
              <Tag key={i} dir="auto">
                {renderInline(block.children, onCite)}
              </Tag>
            );
          }
          case 'paragraph':
            return (
              <p key={i} dir="auto">
                {renderInline(block.children, onCite)}
              </p>
            );
          case 'quote':
            return (
              <blockquote key={i} dir="auto">
                {renderInline(block.children, onCite)}
              </blockquote>
            );
          case 'rule':
            return <hr key={i} />;
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
              <Tag key={i}>
                {block.items.map((item, j) => (
                  <li key={j} dir="auto" style={item.depth ? { marginInlineStart: item.depth * 18 } : undefined}>
                    {renderInline(item.children, onCite)}
                  </li>
                ))}
              </Tag>
            );
          }
          case 'table':
            return (
              <div key={i} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {block.header.map((cell, j) => (
                        <th key={j} dir="auto">
                          {renderInline(cell, onCite)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, j) => (
                      <tr key={j}>
                        {row.map((cell, k) => (
                          <td key={k} dir="auto">
                            {renderInline(cell, onCite)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
});

export { parseInline };
