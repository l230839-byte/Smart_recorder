import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from 'react';
import { Search } from 'lucide-react';

export type IconType = ComponentType<{ size?: number; 'aria-hidden'?: boolean; className?: string; fill?: string }>;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'tonal' | 'outline' | 'ghost' | 'record' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconType;
  /** Shown after the label; for "go forward" actions. */
  trailingIcon?: IconType;
}

export function Button({ variant = 'outline', size = 'md', icon: Icon, trailingIcon: Trailing, children, className = '', ...rest }: ButtonProps) {
  const sizeClass = size === 'md' ? '' : `btn-${size}`;
  return (
    <button type="button" className={`btn btn-${variant} ${sizeClass} ${className}`} {...rest}>
      {Icon && <Icon size={size === 'sm' ? 14 : 16} aria-hidden />}
      {children}
      {Trailing && <Trailing size={size === 'sm' ? 14 : 16} aria-hidden />}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconType;
  /** Required: this is what a screen reader announces, and also the tooltip. */
  label: string;
  size?: number;
  active?: boolean;
}

export function IconButton({ icon: Icon, label, size = 18, active, className = '', ...rest }: IconButtonProps) {
  return (
    <button type="button" aria-label={label} title={label} className={`icon-btn ${active ? 'active' : ''} ${className}`} {...rest}>
      <Icon size={size} aria-hidden />
    </button>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function Chip({ selected, children, onClick }: { selected?: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="chip" aria-pressed={!!selected} onClick={onClick}>
      {children}
    </button>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="grow">
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  );
}

export function SectionTitle({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      {action}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, message, action }: { icon: IconType; title: string; message: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={26} aria-hidden />
      </div>
      <h2>{title}</h2>
      <p className="muted">{message}</p>
      {action}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="center-fill" role="status" aria-label={label}>
      <span className="spinner" />
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${percent}%` }} />
    </div>
  );
}

export function SwitchRow({
  title,
  subtitle,
  checked,
  onChange,
}: {
  title: string;
  subtitle?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="switch-row" onClick={() => onChange(!checked)}>
      <div className="grow">
        <div id={id}>{title}</div>
        {subtitle && <div className="muted small">{subtitle}</div>}
      </div>
      <button
        type="button"
        className="switch"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        onClick={(e) => {
          e.stopPropagation();
          onChange(!checked);
        }}
      />
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <div className="search">
      <Search size={16} aria-hidden />
      <input ref={inputRef} className="input" type="search" aria-label={placeholder} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** Native <dialog>: gives focus trapping, Escape to close and inert background for free. */
export function Dialog({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? 'wide' : ''}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-body">
        <h2>{title}</h2>
        {children}
      </div>
    </dialog>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  destructive,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="muted">{message}</p>
      <div className="dialog-actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant={destructive ? 'danger' : 'primary'}
          autoFocus
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

export function TextPromptDialog({
  title,
  label,
  initial = '',
  confirmLabel = 'Save',
  multiline,
  onConfirm,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
  multiline?: boolean;
  onConfirm: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const id = useId();
  const valid = multiline || value.trim().length > 0;
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          onConfirm(value.trim());
          onClose();
        }}
      >
        <div className="field">
          <label htmlFor={id}>{label}</label>
          {multiline ? (
            <textarea id={id} className="textarea" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
          ) : (
            <input id={id} className="input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
          )}
        </div>
        <div className="dialog-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!valid}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export interface MenuItem {
  label: string;
  icon?: IconType;
  danger?: boolean;
  current?: boolean;
  onSelect: () => void;
}

export function Menu({ icon, label, items }: { icon: IconType; label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    wrap.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = [...(wrap.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };

  return (
    <div className="menu-wrap" ref={wrap}>
      <IconButton icon={icon} label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      {open && (
        <div className="menu" role="menu" aria-label={label} onKeyDown={onMenuKey}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`${item.danger ? 'danger' : ''} ${item.current ? 'current' : ''}`}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon && <item.icon size={15} aria-hidden />}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
