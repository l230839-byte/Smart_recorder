import { BookOpenCheck, CheckSquare, Combine, FileSpreadsheet, FileText, GraduationCap, Languages, ListChecks, Network, NotebookPen, PenLine, Presentation, ScrollText, Wand2 } from 'lucide-react';
import { Card, PageHeader, type IconType } from '../../design/components';
import './studio.css';

/** Prompt §10. Each tool states honestly when it arrives; none of them is clickable until it works. */
const TOOLS: { name: string; hint: string; icon: IconType; phase: number }[] = [
  { name: 'Smart Summarizer', hint: 'Bullets, paragraphs, structured notes and more', icon: ScrollText, phase: 4 },
  { name: 'Lecture Notes', hint: 'Topics, definitions, explanations, examples', icon: NotebookPen, phase: 4 },
  { name: 'PDF Generator', hint: 'Professionally formatted PDFs', icon: FileText, phase: 5 },
  { name: 'Word Generator', hint: 'Editable DOCX files', icon: FileSpreadsheet, phase: 5 },
  { name: 'Presentations', hint: 'Slides from recording content', icon: Presentation, phase: 5 },
  { name: 'Flashcards', hint: 'Question and answer cards', icon: BookOpenCheck, phase: 7 },
  { name: 'Quiz Generator', hint: 'MCQ, true/false, short and long questions', icon: GraduationCap, phase: 7 },
  { name: 'Mind Map', hint: 'A visual map of concepts', icon: Network, phase: 7 },
  { name: 'Action Items', hint: 'Tasks, deadlines, responsibilities', icon: CheckSquare, phase: 7 },
  { name: 'Meeting Minutes', hint: 'Formal meeting documentation', icon: ListChecks, phase: 7 },
  { name: 'Translation Studio', hint: 'Transcripts and generated content', icon: Languages, phase: 7 },
  { name: 'Comparison', hint: 'Differences, themes, changing decisions', icon: Combine, phase: 7 },
  { name: 'Rewrite Studio', hint: 'Reports, articles, emails, explanations', icon: PenLine, phase: 7 },
  { name: 'Custom Studio', hint: 'Your own instructions', icon: Wand2, phase: 7 },
];

export function Studio() {
  return (
    <div className="page">
      <PageHeader title="AI Studio" subtitle="Transform recordings into anything. These tools arrive as their build phases finish." />
      <div className="studio-grid">
        {TOOLS.map((t) => (
          <Card key={t.name} className="studio-tool">
            <t.icon size={20} aria-hidden />
            <div className="grow">
              <h3>{t.name}</h3>
              <p className="muted small">{t.hint}</p>
            </div>
            <span className="badge">Phase {t.phase}</span>
          </Card>
        ))}
      </div>
    </div>
  );
}
