"use client";

import { STATUS_COLOR_CLASSES } from "@/lib/atraso";

export default function StatusAtrasoBadge({ status }) {
  const classes = STATUS_COLOR_CLASSES[status.color];

  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 font-mono text-xs font-medium ${classes.chip}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${classes.dot}`} />
      {status.label}
    </span>
  );
}
