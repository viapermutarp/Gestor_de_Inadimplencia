// Conjunto de ícones inline (sem dependência externa), todos com o mesmo
// traço (stroke, linecap/linejoin arredondados) para manter consistência
// visual. Usados dentro de chips circulares preenchidos com a cor de marca.

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

export function IconReceipt({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <path d="M6 3h12v18l-2.5-1.5L13 21l-2.5-1.5L8 21l-2-1.5V3Z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </svg>
  );
}

export function IconBanknote({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <rect x="3" y="7" width="18" height="11" rx="2" />
      <circle cx="12" cy="12.5" r="2.5" />
      <path d="M6.5 7v11M17.5 7v11" />
    </svg>
  );
}

export function IconChatBubble({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4.5 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
      <path d="M8.5 9.5h7M8.5 12.5h4.5" />
    </svg>
  );
}

export function IconLock({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M7.5 10.5V7a4.5 4.5 0 0 1 9 0v3.5" />
      <path d="M12 14.5v3" />
    </svg>
  );
}

export function IconScale({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <path d="M12 3v17M8 20h8" />
      <path d="M5 7h6M13 7h6" />
      <path d="M5 7 2.5 12a2.5 2.5 0 0 0 5 0L5 7ZM19 7l-2.5 5a2.5 2.5 0 0 0 5 0L19 7Z" />
    </svg>
  );
}

export function IconSearch({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.3-4.3" />
    </svg>
  );
}

export function IconClose({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function IconLogout({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" />
      <path d="M15 16l4-4-4-4M19 12H9" />
    </svg>
  );
}

export function IconChevronLeft({ className = "h-4 w-4" }) {
  return (
    <svg {...base} className={className}>
      <path d="M14.5 5 8 12l6.5 7" />
    </svg>
  );
}

export function IconChevronRight({ className = "h-4 w-4" }) {
  return (
    <svg {...base} className={className}>
      <path d="M9.5 5 16 12l-6.5 7" />
    </svg>
  );
}

export function IconAlert({ className = "h-4 w-4" }) {
  return (
    <svg {...base} className={className}>
      <path d="M12 3.5 21.5 20h-19L12 3.5Z" />
      <path d="M12 9.5v4.25" />
      <circle cx="12" cy="17" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconKey({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <circle cx="8" cy="15" r="3.5" />
      <path d="M10.5 12.5 19 4M16 7l2.5 2.5M13.5 9.5 16 12" />
    </svg>
  );
}

export function IconHistory({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.13" />
      <path d="M3.5 4.5v4h4" />
      <path d="M12 8v4.5l3 2" />
    </svg>
  );
}

export function IconCalendar({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 9.5h17" />
      <path d="M8 3v4M16 3v4" />
      <path d="M7.5 13h2M11 13h2M14.5 13h2M7.5 16.5h2M11 16.5h2" />
    </svg>
  );
}

export function IconCheck({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <path d="M5 12.5 9.5 17 19 6.5" />
    </svg>
  );
}

export function IconCheckCircle({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.25 12.25 10.9 15l4.85-5.5" />
    </svg>
  );
}

export function IconMapPin({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <path d="M12 21.5s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </svg>
  );
}

export function IconUser({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c1-4 4-6 7-6s6 2 7 6" />
    </svg>
  );
}

export function IconUsers({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <circle cx="9" cy="8" r="3.25" />
      <path d="M2.5 20c1-3.8 3.6-5.75 6.5-5.75s5.5 1.95 6.5 5.75" />
      <path d="M15.5 5a3.25 3.25 0 0 1 0 6.3" />
      <path d="M18 14.6c2.1.65 3.6 2.4 4.3 5.4" />
    </svg>
  );
}

export function IconTrendingUp({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <path d="M3 17 9.5 10.5 14 15l6.5-7.5" />
      <path d="M15 7.5h5.5V13" />
    </svg>
  );
}

export function IconChevronDown({ className = "h-4 w-4" }) {
  return (
    <svg {...base} className={className}>
      <path d="M5 8.5 12 15l7-6.5" />
    </svg>
  );
}

export function IconRefresh({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <path d="M4 12a8 8 0 0 1 13.66-5.66L20 8.5" />
      <path d="M20 3.5V8.5H15" />
      <path d="M20 12a8 8 0 0 1-13.66 5.66L4 15.5" />
      <path d="M4 20.5V15.5H9" />
    </svg>
  );
}

export function IconClock({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3.25 2" />
    </svg>
  );
}

export function IconTag({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <path d="M11.5 3.5H5a1.5 1.5 0 0 0-1.5 1.5v6.5a1.5 1.5 0 0 0 .44 1.06l8.5 8.5a1.5 1.5 0 0 0 2.12 0l6.5-6.5a1.5 1.5 0 0 0 0-2.12l-8.5-8.5a1.5 1.5 0 0 0-1.06-.44Z" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconFileText({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v4h4" />
      <path d="M9 13h6M9 16.5h6M9 9.5h2" />
    </svg>
  );
}

export function IconPlus({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconBuilding({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <rect x="4.5" y="3" width="10" height="18" rx="1" />
      <path d="M14.5 9.5H19a1 1 0 0 1 1 1V21h-5.5" />
      <path d="M7.5 7h4M7.5 10.5h4M7.5 14h4M7.5 17.5h4" />
    </svg>
  );
}

export function IconShield({ className = "h-5 w-5" }) {
  return (
    <svg {...base} className={className}>
      <path d="M12 3.5 19 6v6c0 4.5-3 7.5-7 8.5-4-1-7-4-7-8.5V6l7-2.5Z" />
      <path d="M9 12l2 2 4-4.5" />
    </svg>
  );
}
