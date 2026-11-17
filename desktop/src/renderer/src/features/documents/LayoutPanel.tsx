import { useId, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { ACCENTS, MARGINS, PAGE_SIZES, type Accent, type DocumentSettings } from '@shared/documents';
import { IconButton, Segmented, SwitchRow } from '../../design/components';

const LANGUAGES: Record<string, string> = { '': 'Not set', en: 'English', ur: 'Urdu', ar: 'Arabic', hi: 'Hindi', es: 'Spanish', fr: 'French', de: 'German', zh: 'Chinese' };
const ACCENT_NAMES: Record<Accent, string> = { indigo: 'Indigo', teal: 'Teal', ember: 'Ember', slate: 'Slate', crimson: 'Crimson' };

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="layout-group">
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}

function Select<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: Record<string, string>; onChange: (value: T) => void }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="select" value={String(value)} onChange={(e) => onChange((typeof value === 'number' ? Number(e.target.value) : e.target.value) as T)}>
        {Object.entries(options).map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

function Text({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input" dir="auto" maxLength={200} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** Every layout choice from the prompt (§11). Changes apply to the preview and every export format. */
export function LayoutPanel({ settings: s, hasRecording, onChange, onClose }: { settings: DocumentSettings; hasRecording: boolean; onChange: (settings: DocumentSettings) => void; onClose: () => void }) {
  const set = (patch: Partial<DocumentSettings>) => onChange({ ...s, ...patch });
  return (
    <aside className="doc-pane layout-panel" aria-label="Layout and style">
      <div className="layout-head">
        <h2>Layout and style</h2>
        <IconButton icon={X} label="Close layout and style" onClick={onClose} />
      </div>

      <Group title="Title page">
        <SwitchRow title="Cover page" checked={s.coverPage} onChange={(coverPage) => set({ coverPage })} />
        <Text label="Subtitle" value={s.subtitle} onChange={(subtitle) => set({ subtitle })} />
        <Text label="Author" value={s.author} onChange={(author) => set({ author })} />
        <Text label="Date" value={s.date} onChange={(date) => set({ date })} />
        <SwitchRow title="Table of contents" subtitle="Lists main headings" checked={s.toc} onChange={(toc) => set({ toc })} />
      </Group>

      <Group title="Page">
        <Select label="Page size" value={s.pageSize} options={PAGE_SIZES} onChange={(pageSize) => set({ pageSize })} />
        <div className="field">
          <span className="field-label">Margins</span>
          <Segmented label="Margins" value={s.margins} onChange={(margins) => set({ margins })} options={Object.entries(MARGINS).map(([value, label]) => ({ value: value as DocumentSettings['margins'], label }))} />
        </div>
        <SwitchRow title="Page numbers" checked={s.pageNumbers} onChange={(pageNumbers) => set({ pageNumbers })} />
        <Text label="Header text" value={s.header} placeholder="Shown at the top of each page" onChange={(header) => set({ header })} />
        <Text label="Footer text" value={s.footer} placeholder="Shown at the bottom of each page" onChange={(footer) => set({ footer })} />
      </Group>

      <Group title="Text">
        <div className="field">
          <span className="field-label">Font</span>
          <Segmented
            label="Font"
            value={s.font}
            onChange={(font) => set({ font })}
            options={[
              { value: 'sans', label: 'Sans serif' },
              { value: 'serif', label: 'Serif' },
            ]}
          />
        </div>
        <div className="field">
          <span className="field-label">Urdu and Arabic script</span>
          <Segmented
            label="Urdu and Arabic script"
            value={s.urduStyle}
            onChange={(urduStyle) => set({ urduStyle })}
            options={[
              { value: 'nastaliq', label: 'Nastaliq' },
              { value: 'naskh', label: 'Naskh' },
            ]}
          />
        </div>
        <div className="row layout-pair">
          <Select label="Size" value={s.fontSize} options={{ 9: '9 pt', 10: '10 pt', 11: '11 pt', 12: '12 pt', 13: '13 pt', 14: '14 pt' }} onChange={(fontSize) => set({ fontSize })} />
          <Select label="Line spacing" value={s.lineSpacing} options={{ 1.15: '1.15', 1.5: '1.5', 2: 'Double' }} onChange={(lineSpacing) => set({ lineSpacing })} />
        </div>
        <Select label="Paragraph spacing" value={s.paragraphSpacing} options={{ compact: 'Compact', normal: 'Normal', relaxed: 'Relaxed' }} onChange={(paragraphSpacing) => set({ paragraphSpacing })} />
        <Select label="Headings" value={s.headingStyle} options={{ modern: 'Modern', classic: 'Classic', minimal: 'Minimal' }} onChange={(headingStyle) => set({ headingStyle })} />
        <div className="row layout-pair">
          <Select label="Bullets" value={s.bulletStyle} options={{ disc: '• Dot', dash: '– Dash', arrow: '› Arrow' }} onChange={(bulletStyle) => set({ bulletStyle })} />
          <Select label="Numbers" value={s.numberStyle} options={{ decimal: '1, 2, 3', roman: 'i, ii, iii', alpha: 'a, b, c' }} onChange={(numberStyle) => set({ numberStyle })} />
        </div>
        <div className="field">
          <span className="field-label">Accent color</span>
          <div className="accent-row" role="radiogroup" aria-label="Accent color">
            {(Object.keys(ACCENTS) as Accent[]).map((a) => (
              <button key={a} type="button" role="radio" aria-checked={s.accent === a} aria-label={ACCENT_NAMES[a]} title={ACCENT_NAMES[a]} className="accent-swatch" style={{ background: ACCENTS[a] }} onClick={() => set({ accent: a })} />
            ))}
          </div>
        </div>
        <div className="row layout-pair">
          <Select label="Direction" value={s.direction} options={{ auto: 'Automatic', ltr: 'Left to right', rtl: 'Right to left' }} onChange={(direction) => set({ direction })} />
          <Select label="Language" value={s.language} options={LANGUAGES} onChange={(language) => set({ language })} />
        </div>
      </Group>

      <Group title="Content">
        <SwitchRow title="Times" subtitle="Show times such as 3:05 next to content" checked={s.timestamps} onChange={(timestamps) => set({ timestamps })} />
        {hasRecording && (
          <>
            <SwitchRow title="Source note" subtitle="Names the recording the content came from" checked={s.sources} onChange={(sources) => set({ sources })} />
            <SwitchRow title="Full transcript" subtitle="Added at the end" checked={s.transcript} onChange={(transcript) => set({ transcript })} />
            {s.transcript && (
              <>
                <SwitchRow title="Times in the transcript" checked={s.transcriptTimestamps} onChange={(transcriptTimestamps) => set({ transcriptTimestamps })} />
                <SwitchRow title="Speaker names" checked={s.speakerLabels} onChange={(speakerLabels) => set({ speakerLabels })} />
              </>
            )}
          </>
        )}
      </Group>
    </aside>
  );
}
