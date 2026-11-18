import { useMemo, useRef } from 'react';
import { Image as ImageIcon, FileCode } from 'lucide-react';
import { formatDuration } from '@shared/format';
import type { MindNode } from '@shared/studio';
import { Button } from '../../design/components';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';

const BRANCH_COLORS = ['#4338ca', '#0f766e', '#c2410c', '#be123c', '#7c3aed', '#0369a1', '#4d7c0f', '#a16207'];
const ROW = 34;
const COL_GAP = 56;
const PAD = 24;
const CHAR = 7.4;

interface Placed {
  node: MindNode;
  /** Shortened to fit; the full text is in the tooltip. */
  label: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  color: string;
  parent: Placed | null;
}

function width(label: string, depth: number): number {
  return Math.min(320, Math.max(60, label.length * (depth === 0 ? 8.6 : CHAR) + 26));
}

/** A left-to-right tree: each leaf gets a row, each parent sits centred on its children. */
function layout(root: MindNode): { placed: Placed[]; w: number; h: number } {
  const placed: Placed[] = [];
  const colWidth: number[] = [];
  const measure = (n: MindNode, d: number) => {
    colWidth[d] = Math.max(colWidth[d] ?? 0, width(n.label, d));
    n.children.forEach((c) => measure(c, d + 1));
  };
  measure(root, 0);
  const colX = colWidth.map((_, d) => PAD + colWidth.slice(0, d).reduce((s, w) => s + w + COL_GAP, 0));
  let row = 0;
  const place = (n: MindNode, d: number, color: string, parent: Placed | null): Placed => {
    const w = width(n.label, d);
    const self: Placed = { node: n, label: fit(n.label, w, d), x: colX[d]!, y: 0, width: w, depth: d, color, parent };
    placed.push(self);
    if (!n.children.length) self.y = PAD + row++ * ROW + ROW / 2;
    else {
      const kids = n.children.map((c, i) => place(c, d + 1, d === 0 ? BRANCH_COLORS[i % BRANCH_COLORS.length]! : color, self));
      self.y = (kids[0]!.y + kids[kids.length - 1]!.y) / 2;
    }
    return self;
  };
  place(root, 0, '#1c1b18', null);
  const w = colX[colX.length - 1]! + colWidth[colWidth.length - 1]! + PAD;
  return { placed, w, h: Math.max(row, 1) * ROW + PAD * 2 };
}

/** The map as a self-contained SVG, with explicit colours and fonts so it looks the same anywhere. */
function svgMarkup(placed: Placed[], w: number, h: number): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const links = placed
    .filter((p) => p.parent)
    .map((p) => {
      const a = p.parent!;
      const x1 = a.x + a.width;
      const mid = (x1 + p.x) / 2;
      return `<path d="M${x1},${a.y} C${mid},${a.y} ${mid},${p.y} ${p.x},${p.y}" fill="none" stroke="${p.color}" stroke-opacity="0.55" stroke-width="${p.depth === 1 ? 2.5 : 1.6}"/>`;
    })
    .join('');
  const nodes = placed
    .map((p) => {
      const fill = p.depth === 0 ? '#1c1b18' : p.depth === 1 ? p.color : '#ffffff';
      const text = p.depth <= 1 ? '#ffffff' : '#1c1b18';
      const stroke = p.depth >= 2 ? ` stroke="${p.color}" stroke-width="1.4"` : '';
      return `<g><rect x="${p.x}" y="${p.y - 13}" width="${p.width}" height="26" rx="13" fill="${fill}"${stroke}/><text x="${p.x + p.width / 2}" y="${p.y + 4.5}" text-anchor="middle" font-family="Inter, 'Segoe UI', sans-serif" font-size="${p.depth === 0 ? 14 : 12.5}" font-weight="${p.depth <= 1 ? 600 : 450}" fill="${text}">${esc(p.label)}</text></g>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#ffffff"/>${links}${nodes}</svg>`;
}

/** Long labels are shortened on the map; the full text is in the tooltip and in Markdown exports. */
function fit(label: string, w: number, depth: number): string {
  const max = Math.floor((w - 26) / (depth === 0 ? 8.6 : CHAR));
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

export function MindMapView({ root, title, onPlay }: { root: MindNode; title: string; onPlay: (ms: number, recordingId: string) => void }) {
  const toast = useToast();
  const { placed, w, h } = useMemo(() => layout(root), [root]);
  const svg = useRef<SVGSVGElement>(null);
  const shown = placed;
  const markup = () => svgMarkup(placed, w, h);

  const exportSvg = () => void api.saveImage(title, 'svg', new TextEncoder().encode(markup())).then((ok) => ok && toast.show('Mind map saved'), toast.showError);
  const exportPng = () => {
    const image = new Image();
    image.onload = () => {
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(scale, scale);
      ctx.drawImage(image, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) return toast.showError(new Error('Could not draw the image.'));
        void blob.arrayBuffer().then((buf) => api.saveImage(title, 'png', new Uint8Array(buf))).then((ok) => ok && toast.show('Mind map saved'), toast.showError);
      }, 'image/png');
    };
    image.onerror = () => toast.showError(new Error('Could not draw the image.'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup())}`;
  };

  return (
    <div className="mindmap">
      <div className="row">
        <span className="muted small grow">Select a point with a time to hear where it came from.</span>
        <Button size="sm" icon={ImageIcon} onClick={exportPng}>
          Save as PNG
        </Button>
        <Button size="sm" icon={FileCode} onClick={exportSvg}>
          Save as SVG
        </Button>
      </div>
      <div className="mindmap-scroll">
        <svg ref={svg} width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Mind map: ${root.label}`}>
          {shown
            .filter((p) => p.parent)
            .map((p, i) => {
              const a = p.parent!;
              const x1 = a.x + a.width;
              const mid = (x1 + p.x) / 2;
              return <path key={i} d={`M${x1},${a.y} C${mid},${a.y} ${mid},${p.y} ${p.x},${p.y}`} fill="none" stroke={p.color} strokeOpacity={0.55} strokeWidth={p.depth === 1 ? 2.5 : 1.6} />;
            })}
          {shown.map((p, i) => {
            const source = p.node.source;
            const fill = p.depth === 0 ? 'var(--text)' : p.depth === 1 ? p.color : 'var(--surface)';
            const color = p.depth <= 1 ? (p.depth === 0 ? 'var(--bg)' : '#fff') : 'var(--text)';
            return (
              <g
                key={i}
                className={source ? 'mm-node linked' : 'mm-node'}
                role={source ? 'button' : undefined}
                tabIndex={source ? 0 : undefined}
                aria-label={source ? `${p.node.label}, play at ${formatDuration(source.startMs)}` : undefined}
                onClick={() => source && onPlay(source.startMs, source.recordingId)}
                onKeyDown={(e) => source && (e.key === 'Enter' || e.key === ' ') && onPlay(source.startMs, source.recordingId)}
              >
                <title>{source ? `${p.node.label} (${formatDuration(source.startMs)})` : p.node.label}</title>
                <rect x={p.x} y={p.y - 13} width={p.width} height={26} rx={13} fill={fill} stroke={p.depth >= 2 ? p.color : 'none'} strokeWidth={1.4} />
                <text x={p.x + p.width / 2} y={p.y + 4.5} textAnchor="middle" fontSize={p.depth === 0 ? 14 : 12.5} fontWeight={p.depth <= 1 ? 600 : 450} fill={color}>
                  {p.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
