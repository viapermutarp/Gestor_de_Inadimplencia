export default function Spinner({ className = "" }) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-accent border-t-transparent ${className}`}
    />
  );
}
