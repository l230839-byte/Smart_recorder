/** Display formatting shared across screens. */

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Words for totals, such as "2 h 5 min". Anything above zero but under a minute reads "< 1 min". */
export function formatDurationLong(ms: number): string {
  if (ms <= 0) return '0 min';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '< 1 min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatRelative(timestamp: number, now = Date.now()): string {
  const diff = now - timestamp;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 7) return days === 1 ? 'Yesterday' : `${days} days ago`;
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' });
}

export function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
