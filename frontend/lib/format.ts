export function formatPrice(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}

export function humanDuration(minutes: number): string {
  if (minutes < 60) return minutes + " min";
  if (minutes < 1440) return minutes / 60 + " hr";
  if (minutes < 10080) return minutes / 1440 + " day" + (minutes / 1440 > 1 ? "s" : "");
  if (minutes < 43200) return Math.round(minutes / 10080) + " wk";
  if (minutes < 525600) return Math.round(minutes / 1440) + " days";
  return "year";
}

export function tierShortLabel(minutes: number): string {
  if (minutes < 60) return minutes + "m";
  if (minutes < 1440) return minutes / 60 + "h";
  if (minutes < 525600) return Math.round(minutes / 1440) + "d";
  return "1yr";
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
