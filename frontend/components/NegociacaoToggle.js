"use client";

export default function NegociacaoToggle({
  checked,
  loading,
  onChange,
  size = "md",
  labelOn = "Ativado",
  labelOff = "Desativado",
}) {
  const dims = size === "sm" ? "h-5 w-9" : "h-6 w-11";
  const knobDims = size === "sm" ? "h-3.5 w-3.5" : "h-4.5 w-4.5";
  const translate = size === "sm" ? "translate-x-4" : "translate-x-5";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={loading}
      onClick={(e) => {
        e.stopPropagation();
        onChange?.(!checked);
      }}
      className={`relative inline-flex ${dims} shrink-0 items-center rounded-full border transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-60 ${
        checked ? "bg-primary border-primary-hover" : "bg-surface-hover border-border"
      }`}
      title={checked ? labelOn : labelOff}
    >
      <span
        className={`inline-block ${knobDims} transform rounded-full bg-foreground shadow transition-transform duration-200 ${
          checked ? translate : "translate-x-1"
        }`}
      />
      {loading && (
        <span className="absolute -right-5 h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      )}
    </button>
  );
}
