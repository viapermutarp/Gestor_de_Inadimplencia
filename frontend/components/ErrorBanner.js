import { IconAlert } from "@/components/icons";

export default function ErrorBanner({ message, onRetry }) {
  if (!message) return null;
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-status-red/30 bg-status-red/10 px-4 py-3 text-sm text-foreground">
      <span className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-status-red/20 text-status-red">
          <IconAlert className="h-4 w-4" />
        </span>
        {message}
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-lg border border-status-red/40 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-status-red/20"
        >
          Tentar novamente
        </button>
      )}
    </div>
  );
}
