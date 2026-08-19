import { Space_Grotesk, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

// Face de destaque: usada com moderação em títulos e nos números grandes de
// destaque (cards de resumo, contador de bloqueios) — carrega a personalidade
// geométrica/técnica da marca.
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

// Face de corpo/UI: rótulos, textos, navegação, formulários — alta
// legibilidade em tamanhos pequenos, essencial para uma interface densa.
const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

// Face monoespaçada: reservada para dados codificados/numéricos (CPF/CNPJ,
// telefone, valores, datas, chave de API) — alinhamento tabular consistente,
// ajuda a equipe a escanear a tabela rapidamente.
const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata = {
  title: "Gestor de Inadimplência | Via Permuta",
  description: "Painel de controle de cobrança da Via Permuta",
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="pt-BR"
      className={`${spaceGrotesk.variable} ${plexSans.variable} ${plexMono.variable} h-full`}
    >
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
